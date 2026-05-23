import { Buffer } from 'node:buffer'
import { parseResourceLocation } from '../../util/minecraftUtil'
import type { IRenderedAnimation } from '../animationRenderer'
import type { IRenderedRig } from '../rigRenderer'
import type { ExportedFile } from '../util'
import { decomposeTsb, type DecomposedTsb } from './decomposeTsb'

const BONE_TYPES = ['bone', 'text_display', 'item_display', 'block_display']

// TSB Optimized Export の global キュー管理用 storage。 全 blueprint 共有、 minecraft:tick タグに
// 登録した animated_java:global/load_tick がここを監視して priority 別に round-robin で各 bp の
// load/step/<priority> を呼ぶ。 詳細 : docs/tsb-known-issues/parallel-project-load.md。
const GLOBAL_STORAGE_NS = 'aj.global'

// priority レベル。 immediate → high → low の順で消化、 同 priority 内は round-robin。
const PRIORITIES = ['immediate', 'high', 'low'] as const
type Priority = (typeof PRIORITIES)[number]

export interface CreateAnimationStorageTsbOptions {
	blueprintId: string
	quantizationDigits: number
	cellsPerTick: number
	maxLineBytes: number
	loadDebugLog: boolean
}

export interface CreateAnimationStorageTsbResult {
	files: Map<string, ExportedFile>
	animationStorage: string[]
}

interface BoneIdEntry {
	uuid: string
	storageName: string
	id: string
}

interface IdMap {
	bones: BoneIdEntry[]
	locators: BoneIdEntry[]
}

export async function createAnimationStorageTsb(
	rig: IRenderedRig,
	animations: IRenderedAnimation[],
	opts: CreateAnimationStorageTsbOptions
): Promise<CreateAnimationStorageTsbResult> {
	const parsed = parseResourceLocation(opts.blueprintId)
	const fnNs = parsed.namespace
	const bpPath = parsed.path
	const storageNs = `${fnNs}.${bpPath}`
	const fnPathPrefix = `data/${fnNs}/functions/${bpPath}`
	const fnRef = `${fnNs}:${bpPath}`

	const files = new Map<string, ExportedFile>()
	const idMap = buildIdMap(rig)

	files.set(`${fnPathPrefix}/_bone_id_mapping.mcfunction`, {
		content: buildIdMappingComment(idMap, opts.blueprintId),
	})
	files.set(`${fnPathPrefix}/animations/_anim_id_mapping.mcfunction`, {
		content: buildAnimIdMappingComment(animations, opts.blueprintId),
	})
	files.set(`${fnPathPrefix}/cleanup.mcfunction`, {
		content: buildCleanup(storageNs, opts.blueprintId, animations, fnRef),
	})

	const expandRefsByAnim: { anim: string; refs: string[] }[] = []

	// variant データは anim 単位ではなく project 単位の単一関数に集約する :
	//   - 1 anim = 1 行 set value (variant cells は frame_idx 単位で疎、 N 行並べても MAX_LINE_BYTES 内)
	//   - 段階展開せず 1 tick で flush できる軽量データ → expand というより「メタデータ流し込み」
	//   - loaded フラグも project 単位 boolean (`d.loaded_variants`) に縮め、 force_load の guard を簡素化
	const variantsContent = buildProjectVariantsExpand(
		animations,
		rig,
		storageNs,
		opts.blueprintId,
		opts.loadDebugLog
	)
	const variantsExpandRef =
		variantsContent !== null ? `${fnRef}/expand_variants` : null
	if (variantsContent !== null) {
		files.set(`${fnPathPrefix}/expand_variants.mcfunction`, {
			content: variantsContent,
		})
	}

	for (const [animIndex, anim] of animations.entries()) {
		const expandRefs = writeExpandFunctions(
			anim,
			animIndex,
			idMap,
			opts,
			files,
			fnPathPrefix,
			fnRef,
			storageNs
		)
		expandRefsByAnim.push({ anim: anim.storage_name, refs: expandRefs })

		// force_load 同期経路 : variant 未ロード時のみ project 全 variant を同期展開してから
		// bone cells を展開する。 variants が apply_frame の前提条件 (variant 切替 storage 参照) のため。
		files.set(`${fnPathPrefix}/force_load/${anim.storage_name}.mcfunction`, {
			content: buildForceLoad(expandRefs, variantsExpandRef, storageNs),
		})
	}

	files.set(`${fnPathPrefix}/load/init_queue.mcfunction`, {
		content: buildInitQueue(
			expandRefsByAnim,
			variantsExpandRef,
			storageNs,
			opts.blueprintId
		),
	})
	for (const pri of PRIORITIES) {
		files.set(`${fnPathPrefix}/load/step/${pri}.mcfunction`, {
			content: buildLoadStep(pri, storageNs, fnRef),
		})
		files.set(`${fnPathPrefix}/load/rotate_active/${pri}.mcfunction`, {
			content: buildRotateActive(pri, opts.blueprintId),
		})
		files.set(`${fnPathPrefix}/load/remove_from_priority/${pri}.mcfunction`, {
			content: buildRemoveFromPriority(pri, opts.blueprintId, opts.loadDebugLog),
		})
		files.set(`${fnPathPrefix}/load/pop/${pri}.mcfunction`, {
			content: buildPop(pri, storageNs, fnRef),
		})
	}
	files.set(`${fnPathPrefix}/load/dispatch.mcfunction`, {
		content: buildDispatch(),
	})

	return { files, animationStorage: [] }
}

function buildIdMap(rig: IRenderedRig): IdMap {
	// Phase C 整合 : bone_id / locator_id は decimal int に統一 (`current_anim` scoreboard と同じ
	// 表現を path key にも使う = scoreboard から取った int をマクロでそのまま流せる)。 base36 比で
	// 27 bone なら平均 +0.6 文字 / 個、 全 cell の bone path 重複なし (`d.<anim>.bones.<id>` の `<id>`
	// 部分のみ) のため path 長への影響は微小。 mcb の summon 末尾 set 行も同じ順序 (= index) を使う。
	const bones: BoneIdEntry[] = []
	const locators: BoneIdEntry[] = []
	for (const node of Object.values(rig.nodes)) {
		if (BONE_TYPES.includes(node.type)) {
			bones.push({
				uuid: node.uuid,
				storageName: node.storage_name,
				id: bones.length.toString(),
			})
		} else if (node.type === 'locator') {
			locators.push({
				uuid: node.uuid,
				storageName: node.storage_name,
				id: locators.length.toString(),
			})
		}
	}
	return { bones, locators }
}

function buildAnimIdMappingComment(
	animations: IRenderedAnimation[],
	blueprintId: string
): string {
	// 開発時参照用のコメントのみ mcfunction。 関数として実行されない。
	// 各 anim の (anim_id, name, dur, loop_mode, loop_delay, hv, hl) を表形式で記録する。
	const lines = [
		`# Animation ID mapping for blueprint ${blueprintId} (generated by Animated Java TSB Optimized Export).`,
		`# This file is documentation only and is not executed at runtime.`,
		`#`,
		`# scoreboard ${blueprintId.replace(':', '.')}.current_anim:`,
		`#   -1    : stopped`,
		`#   0..N  : currently playing animation index`,
		`#`,
		`# Animation table (stored at ${blueprintId.replace(':', '.')}:meta d.anims[N]):`,
		`#`,
		`#  ID  Name                                dur  loop  delay  hv  hl`,
	]
	animations.forEach((anim, i) => {
		const lp = anim.loop_mode === 'once' ? 'once' : anim.loop_mode === 'loop' ? 'loop' : 'hold'
		const dly = anim.loop_delay || 0
		const hv = anim.frames.some(f => f.variants && f.variants.length > 0) ? 1 : 0
		const lastFrame = anim.frames[anim.frames.length - 1]
		const modifiedEffectNodes = lastFrame
			? Object.values(anim.modified_nodes).filter(
					n => n.type === 'locator' && lastFrame.node_transforms[n.uuid]
			  )
			: []
		const hasLastFrameEffects =
			modifiedEffectNodes.length > 0 ||
			(lastFrame && lastFrame.variants && lastFrame.variants.length > 0) ||
			(lastFrame && lastFrame.function)
		const hl = anim.loop_mode === 'loop' && dly === 0 && hasLastFrameEffects ? 1 : 0
		const idCol = i.toString().padStart(3)
		const nameCol = anim.storage_name.padEnd(34)
		const durCol = anim.duration.toString().padStart(5)
		const lpCol = lp.padStart(5)
		const dlyCol = dly.toString().padStart(6)
		lines.push(`# ${idCol}  ${nameCol}${durCol}  ${lpCol}${dlyCol}   ${hv}   ${hl}`)
	})
	return lines.join('\n') + '\n'
}

function buildIdMappingComment(idMap: IdMap, blueprintId: string): string {
	const lines = [
		`# Bone / locator ID mapping for blueprint ${blueprintId} (generated by Animated Java TSB Optimized Export).`,
		`# This file is documentation only and is not executed at runtime.`,
		`#`,
		`# [bones]`,
	]
	for (const b of idMap.bones) lines.push(`# ${b.id}: ${b.storageName}`)
	if (idMap.locators.length > 0) {
		lines.push(`#`, `# [locators]`)
		for (const l of idMap.locators) lines.push(`# ${l.id}: ${l.storageName}`)
	}
	return lines.join('\n') + '\n'
}

function buildCleanup(
	storageNs: string,
	bpId: string,
	animations: IRenderedAnimation[],
	fnRef: string
): string {
	// `data remove storage` はパス必須 + 対象が無いと throw するため、
	// 全 TSB データを固定ラッパー段 `d` 配下に置き、 execute if data でガードする。
	const kinds = ['anim', 'variants', 'state', 'tmp'] as const
	const storageLines = kinds.map(
		k => `execute if data storage ${storageNs}:${k} d run data remove storage ${storageNs}:${k} d`
	)
	// global キュー管理 storage 内の自 bp 痕跡を削除。 3 priority 別 queue_order に compound 入りうるので
	// 各 priority 別に値一致削除する。 active membership は per-bp の compound (= 3 priority キー子)。
	// 最後に has_work フラグも全 priority 空チェックで条件 remove (= 完全 idle 状態に戻る)。
	const bpIdLit = `"${escapeNbtString(bpId)}"`
	const globalLines: string[] = []
	for (const pri of PRIORITIES) {
		const orderSelector = `${GLOBAL_STORAGE_NS}:state d.queue_order.${pri}[{id:${bpIdLit}}]`
		globalLines.push(
			`execute if data storage ${orderSelector} run data remove storage ${orderSelector}`
		)
	}
	globalLines.push(
		`execute if data storage ${GLOBAL_STORAGE_NS}:state d.active.${bpIdLit} run data remove storage ${GLOBAL_STORAGE_NS}:state d.active.${bpIdLit}`,
		`execute unless data storage ${GLOBAL_STORAGE_NS}:state d.queue_order.immediate[0] unless data storage ${GLOBAL_STORAGE_NS}:state d.queue_order.high[0] unless data storage ${GLOBAL_STORAGE_NS}:state d.queue_order.low[0] run data remove storage ${GLOBAL_STORAGE_NS}:state d.has_work`
	)
	const lines: string[] = [...storageLines, ...globalLines]
	// animation 単位の scoreboard objective 削除は AJ 既存の `remove_animation_objectives` を流用 (DRY)。
	// `tsb_silent_uninstall` フラグで UNINSTALL tellraw 抑制可。
	// 関数が生成されるのは has_animations のときだけなので、 animations が空なら呼ばない。
	if (animations.length > 0) {
		lines.push(`function ${fnRef}/remove_animation_objectives`)
	}
	return lines.join('\n') + '\n'
}

function writeExpandFunctions(
	anim: IRenderedAnimation,
	animIndex: number,
	idMap: IdMap,
	opts: CreateAnimationStorageTsbOptions,
	files: Map<string, ExportedFile>,
	fnPathPrefix: string,
	fnRef: string,
	storageNs: string
): string[] {
	type Item = { line: string }
	const items: Item[] = []
	const animStorageName = anim.storage_name
	// Phase C : storage path 内の anim 識別子は `a_<int>` (decimal int 直接埋め込み)。 scoreboard
	// `aj.<bp>.current_anim` の値 (int) からマクロで `$(anim_id)` に流すだけで path 組立が成立し、
	// base36 変換層が不要。 mcfunction file path (= expand/<storage_name>/p<N>) は debug 用に
	// storage_name を維持する。
	const animPathKey = `a_${animIndex}`
	const cellsPerNode = anim.duration

	for (const b of idMap.bones) {
		if (!(b.uuid in anim.modified_nodes)) continue
		const framesObj = buildBoneFramesObj(b, anim, opts.quantizationDigits)
		if (framesObj === null) continue
		const line = `$data modify storage ${storageNs}:anim d.${animPathKey}.bones.${b.id}$(_) set value ${framesObj}`
		ensureLineWithinLimit(line, anim, b, opts.maxLineBytes)
		items.push({ line })
	}
	for (const l of idMap.locators) {
		if (!(l.uuid in anim.modified_nodes)) continue
		const framesObj = buildLocatorFramesObj(l, anim, opts.quantizationDigits)
		if (framesObj === null) continue
		const line = `$data modify storage ${storageNs}:anim d.${animPathKey}.locators.${l.id}$(_) set value ${framesObj}`
		ensureLineWithinLimit(line, anim, l, opts.maxLineBytes)
		items.push({ line })
	}

	const batches: Item[][] = []
	let current: Item[] = []
	let cells = 0
	for (const item of items) {
		if (cells + cellsPerNode > opts.cellsPerTick && current.length > 0) {
			batches.push(current)
			current = []
			cells = 0
		}
		current.push(item)
		cells += cellsPerNode
	}
	if (current.length > 0) batches.push(current)
	if (batches.length === 0) batches.push([])

	const refs: string[] = []
	for (let i = 0; i < batches.length; i++) {
		const isLast = i === batches.length - 1
		const body = batches[i].map(it => it.line).join('\n')
		const completionLines: string[] = []
		if (isLast) {
			completionLines.push(
				`$data modify storage ${storageNs}:state d.loaded.${animPathKey}$(_) set value 1b`
			)
			if (opts.loadDebugLog) {
				// Server-side staged-load progress log (tsb_load_debug_log = true)。
				// 各 anim の最終 batch (= loaded フラグ立てるタイミング) で発火。
				completionLines.push(buildLoadLogTellraw(opts.blueprintId, `anim ${animStorageName} (id=${animIndex}) loaded`))
			}
		}
		const content = [body, ...completionLines].filter(Boolean).join('\n') + '\n'
		files.set(`${fnPathPrefix}/expand/${animStorageName}/p${i}.mcfunction`, {
			content,
		})
		refs.push(`${fnRef}/expand/${animStorageName}/p${i}`)
	}
	return refs
}

function ensureLineWithinLimit(
	line: string,
	anim: IRenderedAnimation,
	entry: BoneIdEntry,
	maxLineBytes: number
): void {
	const byteSize = Buffer.byteLength(line, 'utf8')
	if (byteSize > maxLineBytes) {
		throw new Error(
			`[TSB] Animation '${anim.storage_name}' の '${entry.storageName}' (id ${entry.id}) のフレーム数が多すぎ (1 行 ${byteSize} バイト > 上限 ${maxLineBytes})。 量子化精度を下げるか、 フレーム間引きするか、 アニメを分割してください。`
		)
	}
}

function buildBoneFramesObj(
	bone: BoneIdEntry,
	anim: IRenderedAnimation,
	digits: number
): string | null {
	const parts: string[] = []
	for (let i = 0; i < anim.frames.length; i++) {
		const transform = anim.frames[i].node_transforms[bone.uuid]
		if (!transform) continue
		// SVD 分解で 7 / 10 / 14 floats を cell 単位で自動振り分け (A-6 参照、 Phase B-1-shear)。
		// transform.matrix は THREE.Matrix4、 .elements が column-major 16 要素。
		const matrix = transform.matrix
		if (!matrix) continue
		const decomposed = decomposeTsb(matrix.elements as unknown as readonly number[], {
			quantizationDigits: digits,
		})
		const values = formatBoneCell(decomposed, digits)
		parts.push(`"${i}":[${values.join(',')}]`)
	}
	if (parts.length === 0) return null
	return `{${parts.join(',')}}`
}

/**
 * `decomposed` を scale_class に応じて 7 / 10 / 14 floats の文字列配列に整形する。
 *
 * - identity : translation 3 + left_rotation 4 = 7 floats (scale 全軸 ≒ 1 のため省略 + right_rotation = I)
 * - uniform  : 上記 + scale 3 = 10 floats (uniform scale のため right_rotation = I で省略可)
 * - non-uniform : 上記 + right_rotation 4 = 14 floats (shear ありうるので SVD で算出した R₂ を載せる)
 */
function formatBoneCell(d: DecomposedTsb, digits: number): string[] {
	const [tx, ty, tz] = d.translation
	const [qx, qy, qz, qw] = d.left_rotation
	const values: string[] = [
		formatTsbFloat(tx, digits),
		formatTsbFloat(ty, digits),
		formatTsbFloat(tz, digits),
		formatTsbFloat(qx, digits),
		formatTsbFloat(qy, digits),
		formatTsbFloat(qz, digits),
		formatTsbFloat(qw, digits),
	]
	if (d.scale_class === 'identity') return values
	const [sx, sy, sz] = d.scale
	values.push(formatTsbFloat(sx, digits), formatTsbFloat(sy, digits), formatTsbFloat(sz, digits))
	if (d.scale_class === 'uniform') return values
	const [rx, ry, rz, rw] = d.right_rotation
	values.push(
		formatTsbFloat(rx, digits),
		formatTsbFloat(ry, digits),
		formatTsbFloat(rz, digits),
		formatTsbFloat(rw, digits)
	)
	return values
}

function buildLocatorFramesObj(
	locator: BoneIdEntry,
	anim: IRenderedAnimation,
	digits: number
): string | null {
	const parts: string[] = []
	for (let i = 0; i < anim.frames.length; i++) {
		const transform = anim.frames[i].node_transforms[locator.uuid]
		if (!transform) continue
		const values = [
			formatTsbFloat(transform.pos[0], digits),
			formatTsbFloat(transform.pos[1], digits),
			formatTsbFloat(transform.pos[2], digits),
			formatTsbFloat(transform.rot[0], digits),
			formatTsbFloat(transform.rot[1], digits),
		]
		parts.push(`"${i}":[${values.join(',')}]`)
	}
	if (parts.length === 0) return null
	return `{${parts.join(',')}}`
}

function buildForceLoad(
	expandRefs: string[],
	variantsExpandRef: string | null,
	storageNs: string
): string {
	const lines: string[] = []
	// variant 同期ロード : `d.loaded_variants` 未立てなら project 全 variant を一括展開してから bone へ。
	// project 単位 boolean なのでガード 1 行で済む。
	if (variantsExpandRef !== null) {
		lines.push(
			`execute unless data storage ${storageNs}:state d.loaded_variants run function ${variantsExpandRef} {_: ""}`
		)
	}
	for (const r of expandRefs) lines.push(`function ${r} {_: ""}`)
	if (lines.length === 0) return '\n'
	return lines.join('\n') + '\n'
}

function buildLoadLogTellraw(blueprintId: string, message: string): string {
	// Phase B-1.5 staged-load progress log。 tsb_load_debug_log フラグで有効化、 サーバ側でのみ tellraw 発火。
	// 各メッセージ : `[TSB] <bp>: <message>` (gray prefix + aqua bp + green message)。
	const safeBp = escapeNbtString(blueprintId)
	const safeMessage = escapeNbtString(message)
	return `tellraw @a [{"text":"[TSB] ","color":"gray"},{"text":"${safeBp}","color":"aqua"},{"text":": ${safeMessage}","color":"green"}]`
}

function buildProjectVariantsExpand(
	animations: IRenderedAnimation[],
	rig: IRenderedRig,
	storageNs: string,
	blueprintId: string,
	loadDebugLog: boolean
): string | null {
	const variantLines: string[] = []
	// Phase C : variant cells path key も anim cell と同じ `a_<int>` 形式に揃える
	// (apply_frame の variant 軸 dispatch が `aj.<bp>:variants d.a_$(anim_id).$(frame)` で
	// path 引くため)。
	for (const [animIndex, anim] of animations.entries()) {
		const parts: string[] = []
		for (let i = 0; i < anim.frames.length; i++) {
			const frame = anim.frames[i]
			if (!frame.variants || frame.variants.length === 0) continue
			const variantUuid = frame.variants[0]
			const variant = rig.variants[variantUuid]
			if (!variant) continue
			const name = escapeNbtString(variant.name)
			const condition = frame.variants_execute_condition
				? escapeNbtString(`${frame.variants_execute_condition} `)
				: ''
			parts.push(`"${i}":{name:"${name}",condition:"${condition}"}`)
		}
		if (parts.length === 0) continue
		variantLines.push(
			`$data modify storage ${storageNs}:variants d.a_${animIndex}$(_) set value {${parts.join(',')}}`
		)
	}
	if (variantLines.length === 0) return null
	// loaded_variants は project 単位 boolean に縮約。 force_load の guard が `d.loaded_variants`
	// 1 個で済むようになり、 アニメ単位の重複立てが消える。
	variantLines.push(
		`$data modify storage ${storageNs}:state d.loaded_variants$(_) set value 1b`
	)
	if (loadDebugLog) {
		variantLines.push(buildLoadLogTellraw(blueprintId, 'variants loaded'))
	}
	return variantLines.join('\n') + '\n'
}

function buildInitQueue(
	expandRefsByAnim: { anim: string; refs: string[] }[],
	variantsExpandRef: string | null,
	storageNs: string,
	bpId: string
): string {
	const buckets: Record<Priority, string[]> = { immediate: [], high: [], low: [] }
	// Phase B-1 暫定 : priority UI 未実装のため、 bone expand は全 anim 分を low に積む。
	// Phase B-1.6 (UI 拡張) で immediate / high への振り分けを導入予定。
	// variant は apply_frame の前提条件 (variant 切替 storage 参照) のため immediate 固定 :
	//   - 1 ref = 1 関数 (project 単位集約済み) で 1 tick で flush 完了 → idle 復帰早い
	//   - global priority 順序保証で variant 先 → bone 後 のロード順序が成立
	for (const { refs } of expandRefsByAnim) buckets.low.push(...refs)
	if (variantsExpandRef !== null) buckets.immediate.push(variantsExpandRef)

	const formatList = (arr: string[]): string =>
		arr.length === 0 ? '[]' : `[${arr.map(r => `"${r}"`).join(',')}]`

	const bpIdLit = `"${escapeNbtString(bpId)}"`
	const lines: string[] = []

	// 1. per-bp queue を 3 priority 別に完全上書き。 set value は MC ソース上 O(N) 単純 replace
	//    で副作用なし、 旧 datapack の残骸 (削除アニメへの expand 参照含む) は破棄される。
	for (const pri of PRIORITIES) {
		lines.push(
			`data modify storage ${storageNs}:state d.queue.${pri} set value ${formatList(buckets[pri])}`
		)
	}

	// 2. ビルド時に該当 priority に値があるかは静的判定可能 → 該当 priority だけ global に登録。
	//    queue_order は priority 別の compound list、 active.<bpId>.<pri> = 1b で重複ガード。
	let hasAnyWork = false
	for (const pri of PRIORITIES) {
		if (buckets[pri].length === 0) continue
		hasAnyWork = true
		lines.push(
			`execute unless data storage ${GLOBAL_STORAGE_NS}:state d.active.${bpIdLit}.${pri} run data modify storage ${GLOBAL_STORAGE_NS}:state d.queue_order.${pri} append value {id:${bpIdLit}}`,
			`data modify storage ${GLOBAL_STORAGE_NS}:state d.active.${bpIdLit}.${pri} set value 1b`
		)
	}

	// 3. work がある場合のみ has_work フラグ立てる。 minecraft:tick タグの load_tick はアイドル時
	//    このフラグだけ見て 1 命令で return するため、 ロード走行外のオーバーヘッドはほぼゼロ。
	if (hasAnyWork) {
		lines.push(`data modify storage ${GLOBAL_STORAGE_NS}:state d.has_work set value 1b`)
	}

	return lines.join('\n') + '\n'
}

function buildLoadStep(priority: Priority, storageNs: string, fnRef: string): string {
	const head = `${storageNs}:state d.queue.${priority}[0]`
	// step は dispatch から「自 bp の該当 priority に必ず work がある」 invariant 下で呼ばれる :
	//   global load_tick で queue_order.<pri>[0] = この bp が選ばれた = active.<bp>.<pri> = 1b。
	// 1 step = pop 1 件 + 残量判定で rotate (round-robin) or remove_from_priority。
	return (
		[
			`function ${fnRef}/load/pop/${priority}`,
			`execute if data storage ${head} run return run function ${fnRef}/load/rotate_active/${priority}`,
			`function ${fnRef}/load/remove_from_priority/${priority}`,
		].join('\n') + '\n'
	)
}

function buildRotateActive(priority: Priority, bpId: string): string {
	const bpIdLit = `"${escapeNbtString(bpId)}"`
	return (
		[
			`data remove storage ${GLOBAL_STORAGE_NS}:state d.queue_order.${priority}[0]`,
			`data modify storage ${GLOBAL_STORAGE_NS}:state d.queue_order.${priority} append value {id:${bpIdLit}}`,
		].join('\n') + '\n'
	)
}

function buildRemoveFromPriority(
	priority: Priority,
	bpId: string,
	loadDebugLog: boolean
): string {
	const bpIdLit = `"${escapeNbtString(bpId)}"`
	const allEmptyCheck = `unless data storage ${GLOBAL_STORAGE_NS}:state d.queue_order.immediate[0] unless data storage ${GLOBAL_STORAGE_NS}:state d.queue_order.high[0] unless data storage ${GLOBAL_STORAGE_NS}:state d.queue_order.low[0]`
	const lines = [
		`data remove storage ${GLOBAL_STORAGE_NS}:state d.queue_order.${priority}[0]`,
		`data remove storage ${GLOBAL_STORAGE_NS}:state d.active.${bpIdLit}.${priority}`,
		// 全 3 priority の queue_order が空 = 全 bp の全 priority work 消化 → has_work クリア
		// (= load_tick はアイドルに戻り、 次 reload まで 1 命令 return 状態)。
		`execute ${allEmptyCheck} run data remove storage ${GLOBAL_STORAGE_NS}:state d.has_work`,
	]
	if (loadDebugLog) {
		// 全 work 完了タイミング = has_work クリアと同条件で発火。 priority ごとに同条件チェックが
		// 走るが、 実発火するのは最後の remove (全 priority queue 空になった瞬間) の 1 回のみ。
		lines.push(`execute ${allEmptyCheck} run ${buildLoadLogTellraw(bpId, 'all anims loaded')}`)
	}
	return lines.join('\n') + '\n'
}

function buildPop(
	priority: 'immediate' | 'high' | 'low',
	storageNs: string,
	fnRef: string
): string {
	return (
		[
			`data modify storage ${storageNs}:tmp d.pop set from storage ${storageNs}:state d.queue.${priority}[0]`,
			`data remove storage ${storageNs}:state d.queue.${priority}[0]`,
			`function ${fnRef}/load/dispatch with storage ${storageNs}:tmp d`,
		].join('\n') + '\n'
	)
}

function buildDispatch(): string {
	return `$function $(pop) {_: ""}\n`
}

function formatTsbFloat(n: number, digits: number): string {
	if (!Number.isFinite(n)) return '0f'
	const s = `${n.toFixed(digits).replace(/\.?0+$/, '')}f`
	if (s.startsWith('-0.')) return `-${s.slice(2)}`
	if (s.startsWith('0.')) return s.slice(1)
	return s
}

function escapeNbtString(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
