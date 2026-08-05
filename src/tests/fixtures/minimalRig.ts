/**
 * `compileMcbProject` を headless で回すための最小 rig fixture。
 *
 * `compileDataPack` (datapackCompiler/index.ts) 全体は `Project!` global / `getFsModule()` /
 * svelte store に依存して Node 上では動かないが、 `compileMcbProject` は
 * sourceFiles / variables / destPath / version / exportedFiles を受け取るだけなので、
 * その手前 (= `variables` の組み立て + `Project` global の stub) を自前で組めば回せる。
 *
 * **前提** : このモジュールは `../formats/blueprint` / `../util/minecraftUtil` が
 * `vi.mock` されている test file からのみ import できる (= どちらも Blockbench 結合の
 * 重いモジュールを芋づるで引くため)。 mock の実体は `mcbCompile.test.ts` を参照。
 */
import * as fs from 'node:fs'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'

import { TextComponent } from 'book-and-quill'
import { NbtCompound, NbtFloat, NbtInt, NbtList, NbtString } from 'deepslate/nbt'

import { DisplayEntityConfig } from '../../nodeConfigs'
import type { IRenderedAnimation } from '../../systems/animationRenderer'
import ENTITY_NAMES from '../../systems/datapackCompiler/entityNames'
import { compileMcbProject } from '../../systems/datapackCompiler/mcbCompiler'
import OBJECTIVES from '../../systems/datapackCompiler/objectives'
import TAGS, { getNodeTags, getRootEntityTags } from '../../systems/datapackCompiler/tags'
import TELLRAW from '../../systems/datapackCompiler/tellraw'
import type { AnyRenderedNode, IRenderedRig } from '../../systems/rigRenderer'
import {
	arrayToNbtFloatArray,
	type ExportedFile,
	matrixToNbtFloatArray,
	transformationToNbt,
} from '../../systems/util'
import { eulerFromQuaternion, roundTo } from '../../util/misc'

// --- fixture の固定値 -------------------------------------------------------

/** fixture が使う blueprint ID。 `aj:test_rig` → 生成先 `data/aj/functions/test_rig/...`。 */
export const BLUEPRINT_ID = 'aj:test_rig'
/** fixture が対象にする Minecraft version (= TSB 最適化経路がサポートする唯一の版)。 */
export const TARGET_VERSION = '1.20.4'
/** 1.20.4 の data pack format。 misode の外部 fetch を迂回するために明示的に渡す。 */
export const DATA_PACK_FORMAT = 26
/**
 * `index.ts:583` は `Math.random()` で export_version を作るが、 fixture では差分比較を
 * 安定させるため固定値を使う。
 */
export const EXPORT_VERSION = '00000000'
/** bone passenger の item id (= production の `aj.display_item`)。 */
export const DISPLAY_ITEM = 'minecraft:stone'

const BONE_TYPES = ['bone', 'text_display', 'item_display', 'block_display']

/**
 * fixture rig の bone uuid。 外から組み上げた `IRenderedAnimation[]` を
 * `FixtureOptions.renderedAnimations` で流し込む場合、 animation 側の node uuid を
 * これに合わせないと `createAnimationStorageTsb` が bone を `modified_nodes` から引けない。
 */
export const BONE_UUID = 'fixture-bone'
const LOCATOR_UUID = 'fixture-locator'
const CAMERA_UUID = 'fixture-camera'

const REPO_ROOT = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), '../../..')
const MCB_DIR = NodePath.join(REPO_ROOT, 'src/systems/datapackCompiler/1.20.4-tsb')

// --- options ----------------------------------------------------------------

export interface FixtureOptions {
	/** variant の一覧。省略時は default 1 個のみ。 */
	variants?: Array<{
		name: string
		isDefault?: boolean
		onApplyFunction?: string
	}>
	/** animation の一覧。省略時は空 (= has_animations: false)。 */
	animations?: Array<{
		name: string
		/** 各 frame の variants 配列。variant keyframe の有無を作るために使う。 */
		frameVariants?: Array<string[] | undefined>
	}>
	/**
	 * 組み上がった `IRenderedAnimation[]` を直接流し込む注入口。
	 *
	 * 指定すると `animations` spec からの合成 (`buildAnimations`) をバイパスし、 これをそのまま
	 * `variables.animations` に載せる。 production の `renderProjectAnimations` の出力を
	 * datapack まで通すために使う。
	 */
	renderedAnimations?: IRenderedAnimation[]
	/**
	 * TSB 最適化経路を使うか。省略時 true。
	 *
	 * 切り替わるのは `variables.tsb_optimized_export` だけで、 読む `.mcb` は常に
	 * `1.20.4-tsb/` (= 両分岐を持つ) のまま。 純正 `1.20.4/` テンプレートには切り替わらない。
	 */
	tsbOptimized?: boolean
}

// --- Blockbench global の stub ----------------------------------------------

/**
 * Blockbench が提供する `compareVersions` global。 `a` が `b` より新しいとき true
 * (= `blockbench-types/custom/util.d.ts:68` の契約)。
 */
function compareVersionsImpl(versionA: string, versionB: string): boolean {
	const a = String(versionA).split('.').map(Number)
	const b = String(versionB).split('.').map(Number)
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0
		const y = b[i] ?? 0
		if (x !== y) return x > y
	}
	return false
}

/**
 * `THREE.Matrix4` の最小 stub。 `matrixToNbtFloatArray` が使う copy / transpose / toArray
 * だけを持つ。
 *
 * three 自体は devDependency として入っている (= `renderHarness.ts` が実物を使う) が、
 * この fixture は matrix 演算を必要とせず identity を配るだけなので、 stub のまま据え置く。
 * `installGlobals` の `g.THREE ??=` は既に実物が載っていれば上書きしないので、
 * harness と同一プロセスで動いても衝突しない。
 */
class Matrix4Stub {
	elements: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

	copy(other: { elements: number[] }): this {
		this.elements = [...other.elements]
		return this
	}

	transpose(): this {
		const e = this.elements
		// column-major 4×4 の転置 (three.js Matrix4.transpose と同じ入れ替え)。
		const swap = (i: number, j: number) => {
			const t = e[i]
			e[i] = e[j]
			e[j] = t
		}
		swap(1, 4)
		swap(2, 8)
		swap(6, 9)
		swap(3, 12)
		swap(7, 13)
		swap(11, 14)
		return this
	}

	toArray(): number[] {
		return [...this.elements]
	}
}

/**
 * `Project!.animated_java` を参照するモジュール群のために global を立てる。
 *
 * 実際にエラーが出て必要だと分かったフィールドだけを載せている :
 * - `blueprint_id` : tellraw.ts の TELLRAW_PREFIX / tags.ts の PROJECT_* タグ
 * - `target_minecraft_version` : tellraw.ts の compareVersions 分岐 / nodeConfigs.ts の toNBT
 * - `custom_rig_entity_tags` : tags.ts の getNodeTags / getRootEntityTags
 */
function installGlobals(): void {
	const g = globalThis as any
	g.compareVersions ??= compareVersionsImpl
	g.THREE ??= { Matrix4: Matrix4Stub }
	g.Project = {
		animated_java: {
			blueprint_id: BLUEPRINT_ID,
			target_minecraft_version: TARGET_VERSION,
			custom_rig_entity_tags: '',
		},
	}
	TextComponent.defaultMinecraftVersion = TARGET_VERSION
}

// --- rig / animation の組み立て ---------------------------------------------

/** 全 node が共有する identity な default_transform。 */
function identityTransform() {
	return {
		matrix: new Matrix4Stub(),
		decomposed: {
			translation: { x: 0, y: 0, z: 0, toArray: () => [0, 0, 0] },
			left_rotation: { x: 0, y: 0, z: 0, w: 1, toArray: () => [0, 0, 0, 1] },
			scale: { x: 1, y: 1, z: 1, toArray: () => [1, 1, 1] },
		},
		pos: [0, 0, 0],
		rot: [0, 0, 0],
		scale: [1, 1, 1],
		head_rot: [0, 0],
	}
}

function buildVariants(options: FixtureOptions) {
	const specs = options.variants ?? [{ name: 'default', isDefault: true }]
	const variants: Record<string, any> = {}
	for (const spec of specs) {
		// variant UUID は名前から決定的に導出する (= fixture 内で frameVariants から引けるように)。
		const uuid = `variant-${spec.name}`
		variants[uuid] = {
			name: spec.name,
			display_name: spec.name,
			uuid,
			texture_map: {},
			excluded_nodes: [],
			...(spec.isDefault ? { is_default: true as const } : {}),
			...(spec.onApplyFunction ? { on_apply_function: spec.onApplyFunction } : {}),
			models: {
				[BONE_UUID]: {
					model: null,
					custom_model_data: 1,
					resource_location: `${BLUEPRINT_ID}/bone`,
					item_model: `${BLUEPRINT_ID}/bone`,
				},
			},
		}
	}
	return variants
}

/**
 * bone 1 / locator 1 (`config.use_entity: true`) / camera 1 の固定構成。
 *
 * `bone_id` は `IRenderedRig` に保存されず `main.mcb` が `Object.values(rig.nodes)` の
 * **挿入順** から割り当てるため、 このオブジェクトリテラルの記述順がそのまま ID 順になる。
 */
function buildRigNodes(): Record<string, AnyRenderedNode> {
	const nodes = {
		[BONE_UUID]: {
			type: 'bone',
			name: 'body',
			storage_name: 'body',
			uuid: BONE_UUID,
			parent: 'root',
			default_transform: identityTransform(),
			base_scale: 1,
			bounding_box: null,
			configs: { default: {}, variants: {} },
		},
		[LOCATOR_UUID]: {
			type: 'locator',
			name: 'muzzle',
			storage_name: 'muzzle',
			uuid: LOCATOR_UUID,
			parent: 'root',
			default_transform: identityTransform(),
			max_distance: 1,
			config: { use_entity: true, entity_type: 'minecraft:marker' },
		},
		[CAMERA_UUID]: {
			type: 'camera',
			name: 'cam',
			storage_name: 'cam',
			uuid: CAMERA_UUID,
			parent: 'root',
			default_transform: identityTransform(),
			max_distance: 1,
		},
	}
	return nodes as unknown as Record<string, AnyRenderedNode>
}

function buildRig(options: FixtureOptions): IRenderedRig {
	return {
		nodes: buildRigNodes(),
		variants: buildVariants(options),
		textures: {},
		model_export_folder: '',
		texture_export_folder: '',
		includes_custom_models: false,
		target_minecraft_version: TARGET_VERSION,
	} as unknown as IRenderedRig
}

function buildAnimations(options: FixtureOptions, rig: IRenderedRig): IRenderedAnimation[] {
	const specs = options.animations ?? []
	const nodes = Object.values(rig.nodes)
	const modified_nodes: Record<string, AnyRenderedNode> = {}
	for (const node of nodes) modified_nodes[node.uuid] = node

	// variant 名 → variant UUID。 frameVariants は名前で書けるようにして、 ここで解決する。
	const variantUuidByName = new Map<string, string>()
	for (const [uuid, variant] of Object.entries(rig.variants)) {
		variantUuidByName.set(variant.name, uuid)
	}

	return specs.map(spec => {
		const frameVariants = spec.frameVariants ?? [undefined]
		const frames = frameVariants.map((names, time) => {
			const node_transforms: Record<string, any> = {}
			for (const node of nodes) node_transforms[node.uuid] = identityTransform()
			const variants = names?.map(name => variantUuidByName.get(name) ?? name)
			return {
				time,
				node_transforms,
				...(variants && variants.length > 0 ? { variants } : {}),
			}
		})
		return {
			name: spec.name,
			storage_name: spec.name,
			uuid: `animation-${spec.name}`,
			loop_delay: 0,
			frames,
			duration: frames.length,
			loop_mode: 'once' as const,
			modified_nodes,
		} as unknown as IRenderedAnimation
	})
}

/**
 * `index.ts:46` の `generateRootEntityPassengers` を fixture 用に写したもの。
 * production 版は非 export + `Variant.getDefault()` (= Blockbench の Variant registry) に
 * 依存するため、 default variant を rig から直接引く形に置き換えている。
 * 対象は 1.20.4 / bone のみ (locator / camera は root に乗らないので switch の default で skip)。
 */
function buildRootEntityPassengers(rig: IRenderedRig): string {
	const allVariants = Object.values(rig.variants)
	// `isDefault` を 1 つも指定しない options でも落ちないよう、 先頭 variant に fallback する。
	const defaultVariant = allVariants.find(v => v.is_default) ?? allVariants[0]
	const passengers = new NbtList()

	for (const [uuid, node] of Object.entries(rig.nodes)) {
		if (node.type === 'struct' || node.type === 'null_object') continue

		const passenger = new NbtCompound()
		passenger.set('Tags', getNodeTags(node, rig))

		if (BONE_TYPES.includes(node.type)) {
			passenger
				.set('height', new NbtFloat(3))
				.set('width', new NbtFloat(3))
				.set('teleport_duration', new NbtInt(0))
				.set('interpolation_duration', new NbtInt(1))
				.set(
					'transformation',
					new NbtCompound()
						.set('translation', arrayToNbtFloatArray([0, 0, 0]))
						.set('left_rotation', arrayToNbtFloatArray([0, 0, 0, 1]))
						.set('right_rotation', arrayToNbtFloatArray([0, 0, 0, 1]))
						.set('scale', arrayToNbtFloatArray([0, 0, 0]))
				)
		}

		if (node.type === 'bone') {
			const variantModel = defaultVariant.models[uuid]
			const item = new NbtCompound()
				.set('id', new NbtString(DISPLAY_ITEM))
				.set(
					'tag',
					new NbtCompound().set(
						'CustomModelData',
						new NbtInt(variantModel.custom_model_data)
					)
				)
				.set('Count', new NbtInt(1))
			passenger
				.set('id', new NbtString('minecraft:item_display'))
				.set('item', item)
				.set('item_display', new NbtString('head'))

			const configs = (node as any).configs
			if (configs?.default) {
				DisplayEntityConfig.fromJSON(configs.default).toNBT(passenger)
			}
		} else {
			// root entity に乗らない node (locator / camera) は passenger にしない。
			continue
		}

		passengers.add(passenger)
	}

	return passengers.toString()
}

/** `index.ts:330` の `nodeSorter` (非 export) をそのまま写したもの。 */
function nodeSorter(a: AnyRenderedNode, b: AnyRenderedNode): number {
	if (a.type === 'locator' && b.type !== 'locator') return 1
	if (a.type !== 'locator' && b.type === 'locator') return -1
	return 0
}

// --- variables --------------------------------------------------------------

/**
 * `compileMcbProject` に渡す `variables` 一式を組み立てる。
 * キー構成は `datapackCompiler/index.ts` の `const variables = {` (= 581 行目付近) と 1:1。
 */
export function buildFixtureVariables(options: FixtureOptions = {}): Record<string, any> {
	installGlobals()

	const tsbOptimized = options.tsbOptimized ?? true
	const rig = buildRig(options)
	const animations = options.renderedAnimations ?? buildAnimations(options, rig)

	// `parseResourceLocation(BLUEPRINT_ID).path` 相当 (= `aj:test_rig` → `test_rig`)。
	const path = BLUEPRINT_ID.split(':').slice(1).join('')
	const relativePathToSrc = path
		.split('/')
		.map(() => '..')
		.join('/')

	const hasCustomVariants = Object.keys(rig.variants).length > 1
	const hasVariantOnApply = Object.values(rig.variants).some(v =>
		Boolean(v.on_apply_function?.trim())
	)
	const hasVariantKeyframes = animations.some(a =>
		a.frames.some(f => (f.variants?.length ?? 0) > 0)
	)

	return {
		relativePathToSrc,
		blueprint_id: BLUEPRINT_ID,
		interpolation_duration: 1,
		teleportation_duration: 1,
		display_item: DISPLAY_ITEM,
		rig,
		animations,
		export_version: EXPORT_VERSION,
		root_entity_passengers: buildRootEntityPassengers(rig),
		TAGS,
		OBJECTIVES,
		TELLRAW,
		ENTITY_NAMES,
		on_summon_function: '',
		on_remove_function: '',
		on_pre_tick_function: '',
		on_post_tick_function: '',
		matrixToNbtFloatArray,
		transformationToNbt,
		use_storage_for_animation: true,
		// TSB 経路の `createAnimationStorageTsb` は常に `[]` を返す (= cell は別ファイルに書き出され、
		// `.mcb` の `animationStorage.join('\n')` は非 TSB 経路でしか使われない)。 非 TSB 経路の
		// `createAnimationStorage` は非 export + svelte store 依存なので、 fixture では常に空にする。
		animationStorage: [],
		tsb_optimized_export: tsbOptimized,
		tsb_quantization_digits_default: 5,
		tsb_cells_per_tick: 1000,
		tsb_max_line_bytes: 1_000_000,
		tsb_silent_uninstall: true,
		tsb_load_debug_log: false,
		rig_hash: 'fixture_rig_hash',
		animation_hash: 'fixture_animation_hash',
		boundingBox: [48, 48],
		DisplayEntityConfig,
		roundTo,
		nodeSorter,
		getRotationFromQuaternion: eulerFromQuaternion,
		has_locators: Object.values(rig.nodes).filter(n => n.type === 'locator').length > 0,
		has_interactions: Object.values(rig.nodes).filter(n => n.type === 'interaction').length > 0,
		has_entity_locators:
			Object.values(rig.nodes).filter(
				n => n.type === 'locator' && (n as any).config?.use_entity
			).length > 0,
		has_ticking_locators:
			Object.values(rig.nodes).filter(
				n => n.type === 'locator' && (n as any).config?.on_tick_function
			).length > 0,
		has_cameras: Object.values(rig.nodes).filter(n => n.type === 'camera').length > 0,
		has_animations: animations.length > 0,
		needs_variant_functions: hasCustomVariants || hasVariantOnApply || hasVariantKeyframes,
		getNodeTags,
		BONE_TYPES,
		project_storage: `${BLUEPRINT_ID}`,
		temp_storage: `animated_java:temp`,
		gu_storage: `animated_java:gu`,
		data_storage: `animated_java:data`,
		auto_update_rig_orientation: false,
		debug_mode: false,
		use_entity_stacking: false,
		root_entity_tags: getRootEntityTags().toString(),
	}
}

// --- compile ----------------------------------------------------------------

/**
 * fixture の rig / animation で `1.20.4-tsb` の `.mcb` をコンパイルし、
 * 生成された mcfunction / json を `パス → 内容` の Map で返す。
 *
 * - `.mcb` は `mcbFiles.ts` 経由ではなく `fs.readFileSync` で直接読む
 *   (= esbuild plugin の文字列 import は vitest で解決できないため)
 * - Map のキーは `PathModule.join` 由来の区切り差を吸収するため `/` に normalize する
 */
export async function compileFixture(options: FixtureOptions = {}): Promise<Map<string, string>> {
	const variables = buildFixtureVariables(options)
	const exportedFiles = new Map<string, ExportedFile>()

	const globalTemplates = fs.readFileSync(NodePath.join(MCB_DIR, 'global.mcbt'), 'utf8')
	const global = fs.readFileSync(NodePath.join(MCB_DIR, 'global.mcb'), 'utf8')
	const main = fs.readFileSync(NodePath.join(MCB_DIR, 'main.mcb'), 'utf8')

	// `parseResourceLocation(BLUEPRINT_ID).fullPath` 相当 (= `aj:test_rig` → `aj/test_rig`)。
	const [namespace, ...rest] = BLUEPRINT_ID.split(':')
	const fullPath = `${namespace}/${rest.join('')}`

	await compileMcbProject({
		sourceFiles: {
			'src/global.mcbt': globalTemplates,
			'src/animated_java.mcb': global,
			[`src/${fullPath}.mcb`]:
				`import ${variables.relativePathToSrc as string}/global.mcbt\n` + main,
		},
		destPath: '.',
		variables,
		version: TARGET_VERSION,
		exportedFiles,
		formatVersion: DATA_PACK_FORMAT,
		quiet: true,
	})

	const result = new Map<string, string>()
	for (const [path, file] of exportedFiles) {
		result.set(path.split(NodePath.sep).join('/'), file.content.toString())
	}
	return result
}
