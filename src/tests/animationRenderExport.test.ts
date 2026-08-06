/**
 * production の `renderProjectAnimations` を Blockbench 無しで実走させ、 render hook 経路が
 * 実際に export 出力へ効くことを機械的に固定する。
 *
 * 確認するのは :
 * 1.  hook 未登録時の出力が決定的であること (= baseline)
 * 1b. hook 未登録時の出力が **hook 導入前の実装と一致すること** (= golden 比較、 下記)
 * 2.  hook 登録で `node_transforms` と `hashAnimations` が変わること
 * 2b. 変化後の値が期待値と一致すること (= 「変わった」 だけでなく 「正しく 1 回分だけ変わった」)
 * 2c. 冪等でない hook を入れると 2b が落ちること (= 2b が二重適用を検出できることの裏取り)
 * 2d. shear だけを加えた場合も hash が変わること (= 旧式の hash では検出できなかった経路)
 * 3.  unregister で baseline へ完全復帰すること
 * 4.  `onPose` の `frameIndex` が 0 から 1 ずつ進み、 同じ値で複数回呼ばれること
 * 5.  `frameTimeSeconds` が frame ループの `time` と全 frame で一致すること
 * 6.  hook が throw しても global 状態 (interpolation フラグ / scene angle) が復旧すること
 * 6b. 本体と `onEndAnimation` が両方 throw したとき、 本体側の例外が伝播すること
 * 6c. cleanup の 1 段が throw しても、 残りの段が走ること
 * 6d. 自分が開いていない session を cleanup で終わらせないこと
 * 6e. `onBeginAnimation` の部分失敗で、 成功済み hook の `onEndAnimation` が 1 回だけ走ること
 * 7.  `onPose` の中から `evaluateBasePose` を呼べて、 `Timeline.time` が戻ること
 * 8.  1 と 2 の render 結果で、 生成される mcfunction が byte 単位で違うこと
 * 9.  context の周期情報が render 結果と一致すること (= `renderSampleCount` == `frames.length`)
 * 9b. `onBeginAnimation` と `onPose` の周期情報が全 dispatch で同一であること
 * 9c. 格子外 / 端数の length でも `renderSampleCount` == `frames.length` が成立すること
 * 9d. context の loop 情報が `rendered` と同一 source から来ていること (= `select()` で割れない)
 * 10.  有限長の **時刻列**が hook 導入前の for ループと一致すること (= 件数上限を設けていない)
 * 10b. `length` が `+Infinity` なら失敗し、 `NaN` / `-Infinity` は従来どおり 0 frame で通ること
 * 10c. frame ループの時刻が進まなくなったら失敗すること (= 無限ループにしない)
 * 10d. 10b / 10c の throw が active な hook session の後始末を通ること
 *
 * `animationRenderer.ts` は import 連鎖の **module 評価時**に Blockbench global を要求する
 * (= `Dialog` / `BoneAnimator.prototype`)。 global を後から生やす方式では越えられないため、
 * 該当 module を `vi.mock` で差し替えている。
 *
 * ## golden (`fixtures/renderBaselineGolden.json`) の再生成手順
 *
 * golden は **hook 導入前の commit (`a886b10e`) の実装が出した値**であり、 現ブランチのコードから
 * 作ったものではない。 これが 1b を 「回帰ガード」 ではなく 「受け入れ条件の証明」 にしている。
 *
 * ただし **hash 値だけは比較に使わない**。 本 PR で `hashAnimations` に `matrix.elements` を
 * 混ぜたため、 golden の `main_hash_legacy_algorithm` は現行実装の出力と一致しない (= 意図した変更)。
 * 比較対象は `animations` の深比較のみで、 hash の決定性は `1.`、 変化への追従は `2.` / `2d.` が見る。
 * harness の fixture 構成 (= bone 1 個 / keyframe 無し / length 0.5) を変えると golden も
 * 作り直しになるので、 そのときは同じ手順を踏むこと。 現ブランチの出力で上書きしてはいけない。
 *
 * 1. `git worktree add --detach <tmp> a886b10e`
 * 2. worktree へ repo の `node_modules` を symlink し、 現行の `renderHarness.ts` をコピーする
 * 3. worktree 内に使い捨ての test を置き、 `renderProjectAnimations` を実走させて
 *    `serializeAnimations` + `hashAnimations` の結果を JSON へ書き出す
 * 4. 出力を本 file の golden へ移し、 `prettier --write` をかける (= 整形後も内容は bit 一致する)
 * 5. `git worktree remove --force <tmp>`
 *
 * harness にアダプタは要らない。 `renderProjectAnimations` と `hashAnimations` の signature は
 * hook 導入の前後で変わっておらず、 harness は `updatePreview` / `getFrame` を直接呼ばないため。
 * mock 一式も、 `animationRenderHooks` を除けばそのまま通る。
 */
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// exportProgress は svelte-patching-tools/blockbench (= `class SvelteDialog extends Dialog`) を
// 芋づるで引き、 module 評価時に `Dialog` global を要求する。 render 経路が使うのは
// observable 3 本の get / set だけなので、 最小の store で差し替える。
vi.mock('../dialogs/exportProgress/exportProgress', () => {
	function observable<T>(initial: T) {
		let value = initial
		return {
			get: () => value,
			set: (next: T) => {
				value = next
			},
		}
	}
	return {
		PROGRESS: observable(0),
		MAX_PROGRESS: observable(1),
		PROGRESS_DESCRIPTION: observable(''),
	}
})

// boneAnimatorMod は top-level で `registerPropertyOverridePatch` を実行し、 module 評価時に
// `BoneAnimator.prototype` を要求する。 render 経路が使うのはフラグの set だけ。
vi.mock('../mods/boneAnimatorMod', () => {
	let enabled = true
	return {
		BONE_INTERPOLATION_ENABLED: {
			get: () => enabled,
			set: (next: boolean) => {
				enabled = next
			},
		},
	}
})

// outliner 4 種は Blockbench の OutlinerElement 継承ツリーを module 評価時に要求する。
// render 経路が触るのは `.all` (= getAnimatableNodes) と `instanceof` (= getNodeMatrix の
// TextDisplay 判定) だけなので、 static `all` を持つ空 class で足りる。
vi.mock('../outliner/interaction', () => ({
	Interaction: class Interaction {
		static all: unknown[] = []
	},
}))
vi.mock('../outliner/textDisplay', () => ({
	TextDisplay: class TextDisplay {
		static all: unknown[] = []
	},
}))
vi.mock('../outliner/vanillaBlockDisplay', () => ({
	VanillaBlockDisplay: class VanillaBlockDisplay {
		static all: unknown[] = []
	},
}))
vi.mock('../outliner/vanillaItemDisplay', () => ({
	VanillaItemDisplay: class VanillaItemDisplay {
		static all: unknown[] = []
	},
}))

// minecraftUtil は constants.getFsModule / systems/minecraft/* を芋づるで引く。
// 使うのは sanitizeStorageKey (= animationRenderer) と toSmallCaps (= tellraw) だけなので、
// production と同一実装をそのまま写す。
vi.mock('../util/minecraftUtil', () => ({
	sanitizeStorageKey: (str: string) => str.toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
	toSmallCaps: (str: string) => str,
	parseResourceLocation(resourceLocation: string) {
		let [namespace, ...parts] = resourceLocation.split(':')
		if (parts.length === 0) {
			parts = [namespace]
			namespace = 'minecraft'
		}
		return { namespace, path: parts.join('') }
	},
}))

// systems/util.ts (= sleepForAnimationFrame の提供元) が引く formats/blueprint は
// svelte component / svg asset / Blockbench API を芋づるで引く。 忠実な最小コピーで差し替える。
vi.mock('../formats/blueprint', () => ({
	projectTargetVersionIsAtLeast(version: string): boolean {
		if (!Project?.animated_java) return false
		return !compareVersions(version, Project.animated_java.target_minecraft_version)
	},
}))

/**
 * `roundToNth` を差し替えるための制御箱。 `stallTime` に数値を入れると `roundToNth` が常に
 * その値を返し、 **frame ループの時刻が進まない状況** (= double の精度限界) を再現できる。
 *
 * 本物の精度限界を踏むには `1e15` 秒級の `animation.length` が要る (= その手前で配列が破裂する)
 * ため、 丸めだけを差し替えて再現している。 `undefined` の間は本物へ委譲するので他の test には効かない。
 */
const MISC_CONTROL = vi.hoisted(() => ({ stallTime: undefined as number | undefined }))
vi.mock('../util/misc', async importOriginal => {
	const actual = await importOriginal<typeof import('../util/misc')>()
	return {
		...actual,
		roundToNth(num: number, nth: number) {
			if (MISC_CONTROL.stallTime !== undefined) return MISC_CONTROL.stallTime
			return actual.roundToNth(num, nth)
		},
	}
})

// tellraw.ts の `import { type IRenderedVariant } from '../rigRenderer'` は verbatimModuleSyntax の
// 下で side-effect import として残り、 型しか使っていないのに実体 (= constants → util/lang の
// LANGUAGES 仮想モジュール) がロードされる。 実行時に参照される値は無いので空モジュールで足りる。
vi.mock('../systems/rigRenderer', () => ({}))

import { BONE_INTERPOLATION_ENABLED } from '../mods/boneAnimatorMod'
import {
	hashAnimations,
	type IRenderedAnimation,
	renderProjectAnimations,
} from '../systems/animationRenderer'
import {
	beginRenderingSession,
	endRenderingSession,
	isRenderingSessionActive,
	RenderHookError,
	registerRenderHooks,
	type RenderAnimationContext,
	type RenderHookContext,
	unregisterRenderHooks,
} from '../systems/animationRenderHooks'
import { createAnimationStorageTsb } from '../systems/datapackCompiler/createAnimationStorageTsb'
import {
	BLUEPRINT_ID,
	BONE_UUID,
	buildFixtureVariables,
	compileFixture,
} from './fixtures/minimalRig'
import GOLDEN from './fixtures/renderBaselineGolden.json'
import {
	createRenderHarness,
	type RenderHarness,
	serializeAnimations,
} from './fixtures/renderHarness'

/**
 * hook が pose に足す Y 方向の平行移動 (= Blockbench 単位)。
 *
 * 回転ではなく平行移動にしているのは、 期待値を書き下せるようにするため。
 * scene の 180 度補正は Y 軸まわりなので **Y 成分に影響しない**うえ、 `getNodeMatrix` は
 * 位置を 1/16 するだけなので、 出力の `pos[1]` は `time + HOOK_OFFSET_BB / 16` になる。
 */
const HOOK_OFFSET_BB = 16
/** 出力座標系での hook の効き幅 (= `HOOK_OFFSET_BB / 16`)。 */
const HOOK_OFFSET = HOOK_OFFSET_BB / 16

const HOOK_ID = 'synthetic-physics'
/** 部分失敗の検証で 2 つ目の hook として使う id。 */
const SECOND_HOOK_ID = 'synthetic-physics-2'

/**
 * shear 検証で matrix に加える量。 **`THREE.Matrix4.decompose` から見えない大きさ**である必要がある。
 *
 * 加え方は `m12 += Δ` / `m21 -= Δ` の反対称ペア。 harness の pose は Y 軸まわりの回転だけなので
 * 全 frame で `m12 = m21 = 0` であり、 このペアは :
 *
 * - `decompose` の scale = 各列のノルム → `sqrt(1 + Δ²)`。 `Δ ≤ 1e-8` なら `1 + Δ²` が double で
 *   1 に丸まるので **bit 単位で不変**
 * - `setFromRotationMatrix` はこの姿勢 (= trace ≤ 0 かつ m22 > m33) で第 2 分岐に入り、
 *   `m12` と `m21` を **和** `(m12 + m21)` の形でしか読まない → `(+Δ) + (-Δ) = 0` で **不変**
 * - 一方 col0 と col1 の内積は `-2Δ` になる → 基底が直交でなくなる = **shear**
 *
 * `1e-7` まで上げると scale と quaternion が動いてしまい 「decompose から見えない」 が崩れる。
 */
const SHEAR_DELTA = 1e-8

/**
 * shear を当てる frame。 **基底が軸並行な frame でないと完全な不可視にはならない**ため 0 に固定する。
 *
 * harness の pose は frame ごとに Y 軸まわり `time` rad の回転が入るので、 frame 0 以外では
 * col0 のノルムが `0.9999999999999999` になり `invSX !== invSY` となる。 すると `decompose` の
 * 正規化で `Δ * invSY - Δ * invSX` が厳密な 0 にならず、 `rot` に 1e-25 度オーダーの残差が出て
 * 旧式 hash の文字列が変わってしまう (= 「旧式は検出できない」 の証明が成立しなくなる)。
 * frame 0 は基底が厳密に軸並行 (= 180 度 Y 回転) なので残差が完全に消える。
 *
 * 裏を返すと、 **旧式 hash が shear を拾えるかどうかは浮動小数の残差次第**であって、
 * shear そのものを見ているわけではない。
 */
const SHEAR_FRAME_INDEX = 0

/**
 * 本 PR で `matrix.elements` を混ぜる前の `hashAnimations` を再現したもの。
 * 「旧式では検出できなかった」 ことを示すためだけに使う (= production には存在しない)。
 */
function legacyHashAnimations(animations: IRenderedAnimation[]) {
	const hash = createHash('sha256')
	for (const animation of animations) {
		hash.update('anim;' + animation.name)
		hash.update(';' + animation.duration.toString())
		hash.update(';' + animation.loop_mode)
		hash.update(';' + (animation.tsb_priority ?? 'low'))
		hash.update(';' + Object.keys(animation.modified_nodes).join(';'))
		for (const frame of animation.frames) {
			hash.update(';' + frame.time.toString())
			for (const [uuid, node] of Object.entries(frame.node_transforms)) {
				hash.update(';' + uuid)
				hash.update(';' + node.pos.join(';'))
				hash.update(';' + node.rot.join(';'))
				hash.update(';' + node.scale.join(';'))
				node.interpolation && hash.update(';' + node.interpolation)
				if (node.function) hash.update(';' + node.function)
				if (node.function_execute_condition)
					hash.update(';' + node.function_execute_condition)
			}
			if (frame.variants) {
				hash.update(';' + frame.variants)
				if (frame.variants_execute_condition)
					hash.update(';' + frame.variants_execute_condition)
			}
			if (frame.function) hash.update(';' + frame.function)
			if (frame.function_execute_condition)
				hash.update(';' + frame.function_execute_condition)
		}
	}
	return hash.digest('hex')
}

/**
 * 1 frame につき 1 回分だけ平行移動を足す hook。
 *
 * `onPose` は 1 frame につき複数回呼ばれるが、 production は各 `updatePreview` の頭で
 * pose を rest から組み直すため、 **絶対値ではなく加算でも結果は 1 回分に収まる** (= 冪等)。
 */
function idempotentOffsetHook(harness: RenderHarness) {
	return {
		onPose() {
			// hook は scene の node pose を直接書き換える契約。
			// `getFrame` が読むのは matrixWorld なので、 書き換え後に再計算まで行う。
			harness.bone.mesh.position.y += HOOK_OFFSET_BB
			globals().Canvas.scene.updateMatrixWorld(true)
		},
	}
}

/** render 経路が触る global を型無しで読むための入口。 */
function globals(): any {
	return globalThis as any
}

/** harness を組んで production の `renderProjectAnimations` を実走させる。 */
async function render(harness: RenderHarness): Promise<IRenderedAnimation[]> {
	return await renderProjectAnimations(harness.project, harness.rig)
}

/** 全 frame の bone transform を数値だけの形に落とす (= 比較しやすくするため)。 */
function extractBoneTransforms(animations: IRenderedAnimation[]) {
	return animations[0].frames.map(frame => {
		const transform = frame.node_transforms[BONE_UUID]
		return {
			time: frame.time,
			pos: transform?.pos,
			rot: transform?.rot,
			matrix: transform?.matrix.elements.slice(),
		}
	})
}

/**
 * 周期情報の検証で使う animation 設定。 harness の既定値 (= `length: 0.5` / `loop: 'once'` /
 * `loop_delay: 0`) のままだと 「context が本当に animation から読んでいるか」 を判別できないため、
 * 3 つとも既定と違う値にしてある。
 */
const TIMING_LENGTH_SECONDS = 0.35
const TIMING_LOOP_MODE = 'loop'
/** Blockbench 側の `loop_delay` は string なので、 数値化されることも併せて見る。 */
const TIMING_LOOP_DELAY_RAW = '3'
const TIMING_LOOP_DELAY = 3

/**
 * `renderSampleCount` の検証で回す animation 長の一覧。
 *
 * **`0.05` の格子から外れた値**と、 **格子ちょうどでも `length / 0.05` が浮動小数で
 * 割り切れない値** (= `0.35` / `0.7`) を混ぜてある。 後者があることで、 `renderSampleCount` を
 * 禁止された別式 (= `Math.floor(length / 0.05) + 1`) で数え直す実装に差し替えたときに
 * この test が落ちる (= 実測から取っていることを実際に見分けられる)。
 */
const TIMING_LENGTHS = [0.02, 0.11, 0.333, 0.35, 0.37, 0.7]

/**
 * 「旧実装と同じ時刻列か」 を見るための animation 長。 端 (= `0`) と、 tick 数が 3 桁に
 * 乗る長さ (= `5`) を含める。
 */
const LEGACY_EQUIVALENCE_LENGTHS = [0, 0.02, 0.35, 0.7, 5]

/**
 * hook 導入前の frame ループが訪れる時刻の列。 当時の
 * `for (let time = 0; time <= animation.length; time = roundToNth(time + 0.05, 20))` を
 * 順序も更新式もそのまま写したもの (= `roundToNth(n, x)` は `Math.round(n * x) / x`)。
 *
 * **production の実装からは独立している**ことに意味がある (= harness の `expectedFrameTimes` も
 * 同じ列を持つが、 そちらが production 追従で書き換わっても、 この関数は旧実装のまま残る)。
 * 守りたい契約は 「件数が同じ」 ではなく 「訪れる時刻が 1 つも変わらない」 なので、
 * 件数ではなく列そのものを返す。
 */
function legacyFrameTimes(length: number): number[] {
	const times: number[] = []
	for (let time = 0; time <= length; time = Math.round((time + 0.05) * 20) / 20) {
		times.push(time)
	}
	return times
}

/** context から周期情報だけを抜く (= `onBeginAnimation` と `onPose` の比較用)。 */
function extractTiming(context: RenderAnimationContext) {
	return {
		animationLengthSeconds: context.animationLengthSeconds,
		renderSampleCount: context.renderSampleCount,
		loopMode: context.loopMode,
		loopDelayFrames: context.loopDelayFrames,
	}
}

/** harness の animation を、 周期情報が既定値と区別できる設定へ差し替える。 */
function applyTimingFixture(harness: RenderHarness) {
	const animation = harness.project.animations[0] as unknown as {
		loop: string
		loop_delay: string
	}
	animation.loop = TIMING_LOOP_MODE
	animation.loop_delay = TIMING_LOOP_DELAY_RAW
}

describe('renderProjectAnimations - hook 経路の実走', () => {
	beforeEach(() => {
		// production が毎 render で戻り値全体を console.log するため、 出力を抑える。
		vi.spyOn(console, 'log').mockImplementation(() => {})
		unregisterRenderHooks(HOOK_ID)
		unregisterRenderHooks(SECOND_HOOK_ID)
	})

	afterEach(() => {
		unregisterRenderHooks(HOOK_ID)
		unregisterRenderHooks(SECOND_HOOK_ID)
		MISC_CONTROL.stallTime = undefined
		vi.restoreAllMocks()
	})

	it('1. hook 未登録の出力は決定的 (= 2 回走らせて完全一致)', async () => {
		const first = await render(createRenderHarness({ boneUuid: BONE_UUID }))
		const second = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		expect(first[0].frames.length).toBeGreaterThan(1)
		expect(extractBoneTransforms(first)).toEqual(extractBoneTransforms(second))
		expect(hashAnimations(first)).toBe(hashAnimations(second))
	})

	it('1b. hook 未登録の出力は main (= a886b10e) の golden と一致する', async () => {
		const animations = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		// transform の深比較が受け入れ条件 (= hook 未登録時の出力が導入前と一致する) の本体。
		// golden の hash 値は比較に使わない (= 本 PR で hashAnimations に matrix を混ぜたため
		// main 由来の値とは一致しない)。 hash の決定性は `1.`、 変化への追従は `2.` が見ている。
		expect(serializeAnimations(animations)).toEqual(GOLDEN.animations)
	})

	it('2. hook を登録すると node_transforms と hash が変わる', async () => {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, idempotentOffsetHook(harness))
		const hooked = await render(harness)

		expect(hooked[0].frames.length).toBe(baseline[0].frames.length)
		expect(extractBoneTransforms(hooked)).not.toEqual(extractBoneTransforms(baseline))
		expect(hashAnimations(hooked)).not.toBe(hashAnimations(baseline))
	})

	it('2d. shear だけを加えると pos / rot / scale は不変でも hash が変わる', async () => {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, {
			onPose(context: RenderHookContext) {
				// frame 0 に限定する (= 下記のとおり、 基底が軸並行な frame でないと
				// decompose の残差が完全には消えないため)。
				if (context.frameIndex !== SHEAR_FRAME_INDEX) return
				// `matrixWorld` を直接いじる (= `mesh.matrix` 側だと次の updateMatrixWorld で
				// TRS から再合成されて消える)。 そのためここでは updateMatrixWorld を呼ばない。
				const elements = harness.bone.mesh.matrixWorld.elements
				elements[4] += SHEAR_DELTA // m12 (= col1.x)
				elements[1] -= SHEAR_DELTA // m21 (= col0.y)
			},
		})
		const sheared = await render(harness)

		// 基底が直交でなくなっている (= shear が乗っている)。
		const shearedMatrix =
			sheared[0].frames[SHEAR_FRAME_INDEX].node_transforms[BONE_UUID].matrix.elements
		const col0 = [shearedMatrix[0], shearedMatrix[1], shearedMatrix[2]]
		const col1 = [shearedMatrix[4], shearedMatrix[5], shearedMatrix[6]]
		const dot = col0[0] * col1[0] + col0[1] * col1[1] + col0[2] * col1[2]
		expect(Math.abs(dot)).toBeCloseTo(2 * SHEAR_DELTA, 12)

		// pos / rot / scale は **bit 単位で** 不変。
		const baseFrames = baseline[0].frames
		const shearedFrames = sheared[0].frames
		expect(shearedFrames.length).toBe(baseFrames.length)
		shearedFrames.forEach((frame, index) => {
			const before = baseFrames[index].node_transforms[BONE_UUID]
			const after = frame.node_transforms[BONE_UUID]
			expect(after.pos).toEqual(before.pos)
			expect(after.rot).toEqual(before.rot)
			expect(after.scale).toEqual(before.scale)
		})
		// matrix は shear を当てた frame だけが変わっている。
		const beforeMatrix = Array.from(
			baseFrames[SHEAR_FRAME_INDEX].node_transforms[BONE_UUID].matrix.elements
		)
		const afterMatrix = Array.from(shearedMatrix)
		expect(afterMatrix).not.toEqual(beforeMatrix)

		// 旧式 (= matrix を mix しない) では変化を検出できなかった。
		expect(legacyHashAnimations(sheared)).toBe(legacyHashAnimations(baseline))
		// 現行実装は検出する。
		expect(hashAnimations(sheared)).not.toBe(hashAnimations(baseline))
	})

	it('2b. hook 適用後の pos が期待値ちょうど (= 複数回呼ばれても 1 回分)', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, idempotentOffsetHook(harness))
		const hooked = await render(harness)

		const frames = hooked[0].frames
		expect(frames.length).toBe(harness.expectedFrameTimes.length)
		frames.forEach(frame => {
			// baseline の pos は [0, time, 0] (= harness の applyPoseAtTime による)。
			// hook が 1 回分だけ効くなら [0, time + 1, 0] になる。
			const pos = frame.node_transforms[BONE_UUID].pos
			expect(pos[0]).toBeCloseTo(0, 9)
			expect(pos[1]).toBeCloseTo(frame.time + HOOK_OFFSET, 9)
			expect(pos[2]).toBeCloseTo(0, 9)
		})
	})

	it('2c. 冪等でない hook なら 2b の期待値から外れる (= 二重適用を検出できる)', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		// dispatch のたびに効き幅が増える hook (= production 側の pose 再構築で吸収されない)。
		let drift = 0
		registerRenderHooks(HOOK_ID, {
			onPose() {
				drift += HOOK_OFFSET_BB
				harness.bone.mesh.position.y += drift
				globals().Canvas.scene.updateMatrixWorld(true)
			},
		})
		const hooked = await render(harness)

		const offExpected = hooked[0].frames.filter(frame => {
			const pos = frame.node_transforms[BONE_UUID].pos
			return Math.abs(pos[1] - (frame.time + HOOK_OFFSET)) > 1e-6
		})
		expect(offExpected.length).toBeGreaterThan(0)
	})

	it('3. unregister すると baseline へ完全復帰する', async () => {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, idempotentOffsetHook(harness))
		const hooked = await render(harness)
		expect(hashAnimations(hooked)).not.toBe(hashAnimations(baseline))

		unregisterRenderHooks(HOOK_ID)
		const restored = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		expect(extractBoneTransforms(restored)).toEqual(extractBoneTransforms(baseline))
		expect(hashAnimations(restored)).toBe(hashAnimations(baseline))
	})

	it('4. onPose の frameIndex は 0 から 1 ずつ進み、 同じ値で複数回呼ばれる', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const calls: Array<{ frameIndex: number; frameTimeSeconds: number; timeSeconds: number }> =
			[]
		registerRenderHooks(HOOK_ID, {
			onPose(context: RenderHookContext) {
				calls.push({
					frameIndex: context.frameIndex,
					frameTimeSeconds: context.frameTimeSeconds,
					timeSeconds: context.timeSeconds,
				})
			},
		})
		const animations = await render(harness)

		const frameCount = animations[0].frames.length
		expect(frameCount).toBe(harness.expectedFrameTimes.length)

		// 出現する frameIndex の集合が [0..N-1] で、 各値が 1 回以上出ること。
		const distinct = [...new Set(calls.map(call => call.frameIndex))]
		expect(distinct).toEqual([...Array(frameCount).keys()])
		for (const index of distinct) {
			expect(calls.filter(call => call.frameIndex === index).length).toBeGreaterThanOrEqual(1)
		}
		// 同じ frameIndex で複数回呼ばれる (= advance は frameIndex 単位で 1 回だけ)。
		expect(calls.length).toBeGreaterThan(frameCount)
		// frameIndex は単調非減少 (= 戻らない)。
		for (let i = 1; i < calls.length; i++) {
			expect(calls[i].frameIndex).toBeGreaterThanOrEqual(calls[i - 1].frameIndex)
		}
		// frameTimeSeconds は frameIndex / 20、 timeSeconds はそれ自身か side sample (+0.001)。
		for (const call of calls) {
			expect(call.frameTimeSeconds).toBe(call.frameIndex / 20)
			const delta = call.timeSeconds - call.frameTimeSeconds
			expect(delta === 0 || Math.abs(delta - 0.001) < 1e-9).toBe(true)
		}
	})

	it('5. frameTimeSeconds が frame ループの time と全 frame で一致する', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const seenTimes = new Map<number, number>()
		registerRenderHooks(HOOK_ID, {
			onPose(context: RenderHookContext) {
				seenTimes.set(context.frameIndex, context.frameTimeSeconds)
			},
		})
		const animations = await render(harness)

		const frames = animations[0].frames
		expect(seenTimes.size).toBe(frames.length)
		frames.forEach((frame, index) => {
			expect(seenTimes.get(index)).toBe(frame.time)
			expect(frame.time).toBe(harness.expectedFrameTimes[index])
		})
	})

	it('6. hook が throw しても interpolation フラグと scene angle が復旧する', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const cause = new Error('physics exploded')
		registerRenderHooks(HOOK_ID, {
			onPose() {
				throw cause
			},
		})

		const caught = await render(harness).then(
			() => undefined,
			(error: unknown) => error
		)

		// (a)(b) reject し、 RenderHookError で hookId / phase / cause を保つ
		expect(caught).toBeInstanceOf(RenderHookError)
		expect((caught as RenderHookError).hookId).toBe(HOOK_ID)
		expect((caught as RenderHookError).phase).toBe('onPose')
		expect((caught as RenderHookError).cause).toBe(cause)
		// (c) BONE_INTERPOLATION_ENABLED が true に戻っている
		expect(BONE_INTERPOLATION_ENABLED.get()).toBe(true)
		// (d) scene の 180 度回転が戻っている (= 単位 quaternion)
		expect(harness.scene.quaternion.w).toBeCloseTo(1, 9)
		expect(harness.scene.quaternion.y).toBeCloseTo(0, 9)
	})

	it('6b. onPose と onEndAnimation が両方 throw したら onPose 由来が伝播する', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const poseCause = new Error('pose exploded')
		const endCause = new Error('cleanup exploded')
		registerRenderHooks(HOOK_ID, {
			onPose() {
				throw poseCause
			},
			onEndAnimation() {
				throw endCause
			},
		})

		const caught = await render(harness).then(
			() => undefined,
			(error: unknown) => error
		)

		// 本体 (= frame ループ内の onPose) 由来が優先される。
		expect(caught).toBeInstanceOf(RenderHookError)
		expect((caught as RenderHookError).phase).toBe('onPose')
		expect((caught as RenderHookError).cause).toBe(poseCause)

		// cleanup (= onEndAnimation) 由来は console.warn に落ちる。
		const warned = warn.mock.calls
			.map(call => call[0])
			.filter(
				(arg): arg is RenderHookError =>
					arg instanceof RenderHookError && arg.phase === 'onEndAnimation'
			)
		expect(warned.length).toBe(1)
		expect(warned[0].cause).toBe(endCause)
		warn.mockRestore()
	})

	it('6c. 選択 animation の復元は select() が throw しても setTime / preview が走る', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const animation = harness.project.animations[0] as unknown as {
			select: () => void
		}
		// renderAnimation が冒頭で 1 回呼ぶので、 cleanup 側の 2 回目だけ throw させる。
		let selectCalls = 0
		const selectCause = new Error('select exploded')
		animation.select = () => {
			selectCalls++
			if (selectCalls >= 2) throw selectCause
		}
		let previewCalls = 0
		globals().Animator.preview = () => {
			previewCalls++
		}
		// cleanup の setTime がこの値へ戻すことを確認する (= frame ループ後の時刻と区別できる値)。
		globals().Timeline.time = 0.3

		const caught = await render(harness).then(
			() => undefined,
			(error: unknown) => error
		)

		// 本体は正常終了しているので、 cleanup 側の例外がそのまま出る。
		expect(caught).toBe(selectCause)
		expect(selectCalls).toBe(2)
		// select() が throw しても後続の 2 step が走っている。
		expect(globals().Timeline.time).toBe(0.3)
		expect(previewCalls).toBe(1)
	})

	it('6e. onBeginAnimation の部分失敗で、 成功済み hook の onEndAnimation が 1 回だけ走る', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const cause = new Error('begin exploded')
		let endAnimationCalls = 0
		registerRenderHooks(HOOK_ID, {
			onBeginAnimation() {},
			onEndAnimation() {
				endAnimationCalls++
			},
		})
		registerRenderHooks(SECOND_HOOK_ID, {
			onBeginAnimation() {
				throw cause
			},
		})

		const caught = await render(harness).then(
			() => undefined,
			(error: unknown) => error
		)
		unregisterRenderHooks(SECOND_HOOK_ID)

		// registry 側の unwind が送る 1 回だけ (= cleanup の dispatchEndAnimation と二重にならない)。
		expect(endAnimationCalls).toBe(1)
		// 伝播するのは失敗した hook 由来の例外。
		expect(caught).toBeInstanceOf(RenderHookError)
		expect((caught as RenderHookError).hookId).toBe(SECOND_HOOK_ID)
		expect((caught as RenderHookError).phase).toBe('onBeginAnimation')
		expect((caught as RenderHookError).cause).toBe(cause)
		// global 状態は復旧している。
		expect(BONE_INTERPOLATION_ENABLED.get()).toBe(true)
		expect(harness.scene.quaternion.w).toBeCloseTo(1, 9)
		expect(harness.scene.quaternion.y).toBeCloseTo(0, 9)
	})

	it('6d. 自分が開いていない session を cleanup で終わらせない', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, { onPose() {} })

		// 別の render が既に session を開いている状況を作る (= 並行実行の再現)。
		beginRenderingSession()
		expect(isRenderingSessionActive()).toBe(true)

		// 2 本目は beginRenderingSession が「既に active」で throw する。
		const caught = await render(harness).then(
			() => undefined,
			(error: unknown) => error
		)
		expect(caught).toBeInstanceOf(Error)

		// 2 本目の cleanup は自分が開いた session ではないので閉じない。
		expect(isRenderingSessionActive()).toBe(true)

		endRenderingSession()
		expect(isRenderingSessionActive()).toBe(false)
	})

	it('7. onPose の中から evaluateBasePose を呼べて Timeline.time が戻る', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		const observed: Array<{ before: number; after: number }> = []
		registerRenderHooks(HOOK_ID, {
			onPose(context: RenderHookContext) {
				const before = globals().Timeline.time as number
				context.evaluateBasePose(0.1)
				observed.push({ before, after: globals().Timeline.time as number })
			},
		})

		const animations = await render(harness)

		expect(animations[0].frames.length).toBeGreaterThan(1)
		expect(observed.length).toBeGreaterThan(0)
		for (const entry of observed) {
			expect(entry.after).toBe(entry.before)
		}
	})

	it('9. onBeginAnimation の周期情報が render 結果と一致する', async () => {
		const harness = createRenderHarness({
			boneUuid: BONE_UUID,
			animationLength: TIMING_LENGTH_SECONDS,
		})
		applyTimingFixture(harness)

		let timing: ReturnType<typeof extractTiming> | undefined
		registerRenderHooks(HOOK_ID, {
			onBeginAnimation(context: RenderAnimationContext) {
				timing = extractTiming(context)
			},
		})
		const animations = await render(harness)

		expect(timing).toBeDefined()
		// renderSampleCount は frame ループが実際に回った回数そのもの (= 別式で数え直していない)。
		expect(timing!.renderSampleCount).toBe(animations[0].frames.length)
		expect(timing!.renderSampleCount).toBe(harness.expectedFrameTimes.length)
		// datapack meta の dur / lp / dly の元になる値と一致する。
		expect(timing!.renderSampleCount).toBe(animations[0].duration)
		expect(timing!.loopMode).toBe(animations[0].loop_mode)
		expect(timing!.loopDelayFrames).toBe(animations[0].loop_delay)
		// 既定値ではなく animation から読んでいる。
		expect(timing!.animationLengthSeconds).toBe(TIMING_LENGTH_SECONDS)
		expect(timing!.loopMode).toBe(TIMING_LOOP_MODE)
		expect(timing!.loopDelayFrames).toBe(TIMING_LOOP_DELAY)
	})

	it('9b. onPose の周期情報は onBeginAnimation と全 dispatch で同一', async () => {
		const harness = createRenderHarness({
			boneUuid: BONE_UUID,
			animationLength: TIMING_LENGTH_SECONDS,
		})
		applyTimingFixture(harness)

		let beginTiming: ReturnType<typeof extractTiming> | undefined
		const poseTimings: Array<ReturnType<typeof extractTiming>> = []
		registerRenderHooks(HOOK_ID, {
			onBeginAnimation(context: RenderAnimationContext) {
				beginTiming = extractTiming(context)
			},
			onPose(context: RenderHookContext) {
				poseTimings.push(extractTiming(context))
			},
		})
		const animations = await render(harness)

		expect(beginTiming).toBeDefined()
		expect(poseTimings.length).toBeGreaterThan(animations[0].frames.length)
		for (const timing of poseTimings) {
			expect(timing).toEqual(beginTiming)
		}
		expect(beginTiming!.renderSampleCount).toBe(animations[0].frames.length)
	})

	it('9c. 格子外 / 端数の length でも renderSampleCount が frames.length と一致する', async () => {
		const observed: Array<{ length: number; count: number }> = []

		for (const length of TIMING_LENGTHS) {
			const harness = createRenderHarness({ boneUuid: BONE_UUID, animationLength: length })
			let timing: ReturnType<typeof extractTiming> | undefined
			registerRenderHooks(HOOK_ID, {
				onBeginAnimation(context: RenderAnimationContext) {
					timing = extractTiming(context)
				},
			})
			const animations = await render(harness)
			unregisterRenderHooks(HOOK_ID)

			const frameCount = animations[0].frames.length
			expect(timing, `length=${length}`).toBeDefined()
			expect(timing!.renderSampleCount, `length=${length}`).toBe(frameCount)
			expect(timing!.renderSampleCount, `length=${length}`).toBe(
				harness.expectedFrameTimes.length
			)
			expect(timing!.animationLengthSeconds, `length=${length}`).toBe(length)
			observed.push({ length, count: frameCount })
		}

		// 禁止した別式 (= `Math.floor(length / 0.05) + 1`) では少なくとも 1 件で値がずれる。
		// これが 0 件だと、 別式へ差し替えても上の assert が全部通ってしまう (= test が
		// 「実測から取っていること」 を見分けられない) ので、 case 選びごと守る。
		const divergent = observed.filter(
			entry => Math.floor(entry.length / 0.05) + 1 !== entry.count
		)
		expect(divergent.length).toBeGreaterThan(0)
	})

	it('9d. context の loop 情報は rendered と同一 source (= select() 中の書き換えで割れない)', async () => {
		const harness = createRenderHarness({
			boneUuid: BONE_UUID,
			animationLength: TIMING_LENGTH_SECONDS,
		})
		applyTimingFixture(harness)

		// Blockbench の `Animation.select()` は `select_animation` を同期 dispatch するため、
		// listener が loop 設定を書き換えうる。 `rendered` 側は select() の**前**に値を確定させて
		// いるので、 context が `animation` から読み直していると
		// 「context = 新値 / datapack meta = 旧値」 に割れる。 それを再現する。
		const animation = harness.project.animations[0] as unknown as {
			loop: string
			loop_delay: string
			select: () => void
		}
		animation.select = () => {
			animation.loop = 'hold'
			animation.loop_delay = '99'
		}

		let timing: ReturnType<typeof extractTiming> | undefined
		registerRenderHooks(HOOK_ID, {
			onBeginAnimation(context: RenderAnimationContext) {
				timing = extractTiming(context)
			},
		})
		const animations = await render(harness)

		// select() が実際に値を書き換えている (= 前提が成立している)。
		expect(animation.loop).toBe('hold')
		expect(animation.loop_delay).toBe('99')
		// context は datapack meta 側 (= rendered) と同じ値のまま。
		expect(timing!.loopMode).toBe(animations[0].loop_mode)
		expect(timing!.loopDelayFrames).toBe(animations[0].loop_delay)
		expect(timing!.loopMode).toBe(TIMING_LOOP_MODE)
		expect(timing!.loopDelayFrames).toBe(TIMING_LOOP_DELAY)
	})

	it('10. 有限長の時刻列は hook 導入前の for ループと一致する (= 件数上限を設けない)', async () => {
		for (const length of LEGACY_EQUIVALENCE_LENGTHS) {
			const harness = createRenderHarness({ boneUuid: BONE_UUID, animationLength: length })
			let timing: ReturnType<typeof extractTiming> | undefined
			registerRenderHooks(HOOK_ID, {
				onBeginAnimation(context: RenderAnimationContext) {
					timing = extractTiming(context)
				},
			})
			const animations = await render(harness)
			unregisterRenderHooks(HOOK_ID)

			const expected = legacyFrameTimes(length)
			// 件数ではなく **訪れた時刻そのもの**を比較する (= 「件数は同じだが時刻がずれた」
			// 回帰を落とすため)。 `frame.time` は frame ループの `time` がそのまま入る。
			expect(
				animations[0].frames.map(frame => frame.time),
				`length=${length}`
			).toEqual(expected)
			expect(animations[0].duration, `length=${length}`).toBe(expected.length)
			expect(timing!.renderSampleCount, `length=${length}`).toBe(expected.length)
		}
	})

	it('10b. length が +Infinity なら失敗し、 NaN / -Infinity は 0 frame で通る', async () => {
		/**
		 * harness を組んでから `length` だけ差し替える。 `createRenderHarness` の期待値生成
		 * (= `expectedFrameTimes`) が `Infinity` では終わらないため、 option 経由では渡せない。
		 */
		const withLength = (length: number) => {
			const harness = createRenderHarness({ boneUuid: BONE_UUID })
			;(harness.project.animations[0] as unknown as { length: number }).length = length
			return harness
		}

		// +Infinity は `time <= length` が永久に真 (= 旧実装はハングしていた) なので失敗させる。
		const infinite = withLength(Infinity)
		const caught = await render(infinite).then(
			() => undefined,
			(error: unknown) => error
		)
		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain('non-finite length')
		// 既存の bodyError / cleanup 経路に乗っているので global 状態は復旧している。
		expect(BONE_INTERPOLATION_ENABLED.get()).toBe(true)
		expect(infinite.scene.quaternion.w).toBeCloseTo(1, 9)

		// NaN / -Infinity は旧実装でも比較が偽で 0 件だったので、 その挙動を保つ (= throw しない)。
		for (const length of [NaN, -Infinity]) {
			const animations = await render(withLength(length))
			expect(animations[0].frames.length, `length=${length}`).toBe(0)
			expect(animations[0].duration, `length=${length}`).toBe(0)
		}
	})

	it('10c. frame ループの時刻が進まなくなったら失敗する (= 無限ループにしない)', async () => {
		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		// `roundToNth` が常に 0 を返す = 1 周目の時点で時刻が進まない状況。
		MISC_CONTROL.stallTime = 0

		const caught = await render(harness).then(
			() => undefined,
			(error: unknown) => error
		)

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain('stopped advancing')
		expect(BONE_INTERPOLATION_ENABLED.get()).toBe(true)
		expect(harness.scene.quaternion.w).toBeCloseTo(1, 9)
	})

	it('10d. 10b / 10c の throw は active な hook session の後始末を通る', async () => {
		/**
		 * noop hook を登録した状態で render を走らせ、 呼ばれた callback を記録する。
		 * 10b / 10c は hook 未登録 (= session を張らない) で走るため、 session 側の
		 * 後始末が通ることはそちらでは見えない。
		 */
		const runWithSession = async (prepare: () => RenderHarness) => {
			const log: string[] = []
			registerRenderHooks(HOOK_ID, {
				onBeginRendering: () => log.push('beginRendering'),
				onBeginAnimation: () => log.push('beginAnimation'),
				onPose: () => log.push('pose'),
				onEndAnimation: () => log.push('endAnimation'),
				onEndRendering: () => log.push('endRendering'),
			})
			const harness = prepare()
			const caught = await render(harness).then(
				() => undefined,
				(error: unknown) => error
			)
			unregisterRenderHooks(HOOK_ID)
			return { log, caught, harness }
		}

		// (a) 非有限 length。 throw は animation 単位の context を組む前に出る。
		const infinite = await runWithSession(() => {
			const harness = createRenderHarness({ boneUuid: BONE_UUID })
			;(harness.project.animations[0] as unknown as { length: number }).length = Infinity
			return harness
		})
		expect((infinite.caught as Error).message).toContain('non-finite length')
		// session は開いたが animation 段へは進んでおらず、 onEndRendering はちょうど 1 回。
		expect(infinite.log).toEqual(['beginRendering', 'endRendering'])
		expect(isRenderingSessionActive()).toBe(false)
		expect(BONE_INTERPOLATION_ENABLED.get()).toBe(true)
		expect(infinite.harness.scene.quaternion.w).toBeCloseTo(1, 9)

		// (b) 時刻が進まないケースも同じ位置で throw する。
		const stalled = await runWithSession(() => {
			const harness = createRenderHarness({ boneUuid: BONE_UUID })
			MISC_CONTROL.stallTime = 0
			return harness
		})
		expect((stalled.caught as Error).message).toContain('stopped advancing')
		expect(stalled.log).toEqual(['beginRendering', 'endRendering'])
		expect(isRenderingSessionActive()).toBe(false)
		expect(BONE_INTERPOLATION_ENABLED.get()).toBe(true)
		expect(stalled.harness.scene.quaternion.w).toBeCloseTo(1, 9)
	})
})

describe('renderProjectAnimations - datapack までの byte 差分', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		unregisterRenderHooks(HOOK_ID)
		unregisterRenderHooks(SECOND_HOOK_ID)
	})

	afterEach(() => {
		unregisterRenderHooks(HOOK_ID)
		unregisterRenderHooks(SECOND_HOOK_ID)
		vi.restoreAllMocks()
	})

	/** hook 無し / 有りの 2 種類の render 結果を作る。 */
	async function renderBaselineAndHooked() {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, idempotentOffsetHook(harness))
		const hooked = await render(harness)
		unregisterRenderHooks(HOOK_ID)

		return { baseline, hooked }
	}

	/** TSB 経路の animation storage を生成する (= frame data が実際に載るファイル群)。 */
	async function buildStorage(animations: IRenderedAnimation[]) {
		const variables = buildFixtureVariables({ renderedAnimations: animations })
		const result = await createAnimationStorageTsb(
			variables.rig as never,
			animations as never,
			{
				blueprintId: BLUEPRINT_ID,
				quantizationDigits: 5,
				cellsPerTick: 1000,
				maxLineBytes: 1_000_000,
				loadDebugLog: false,
			}
		)
		const files = new Map<string, string>()
		for (const [path, file] of result.files) files.set(path, String(file.content))
		return files
	}

	it('8. hook の有無で animation storage の mcfunction が byte 単位で変わる', async () => {
		const { baseline, hooked } = await renderBaselineAndHooked()

		const baselineFiles = await buildStorage(baseline)
		const hookedFiles = await buildStorage(hooked)

		// 生成されるファイル構成そのものは変わらない (= 変わるのは中身)。
		expect([...hookedFiles.keys()].sort()).toEqual([...baselineFiles.keys()].sort())

		const changed = [...baselineFiles.keys()].filter(
			path => baselineFiles.get(path) !== hookedFiles.get(path)
		)
		expect(changed.length).toBeGreaterThan(0)
		// 変わるのは bone の frame data (= expand で storage へ書き込む cell) を持つファイル。
		expect(changed.some(path => path.includes('/expand/'))).toBe(true)
	})

	it('8b. .mcb 側の scaffolding は pose 非依存 (= hook の有無で完全一致)', async () => {
		const { baseline, hooked } = await renderBaselineAndHooked()

		const baselineFiles = await compileFixture({ renderedAnimations: baseline })
		const hookedFiles = await compileFixture({ renderedAnimations: hooked })

		// frame data は `createAnimationStorageTsb` 側の cell ファイルに載るため、
		// `compileMcbProject` の生成物は frame 数 / 名前が同じなら byte 一致する。
		expect([...hookedFiles.keys()].sort()).toEqual([...baselineFiles.keys()].sort())
		const changed = [...baselineFiles.keys()].filter(
			path => baselineFiles.get(path) !== hookedFiles.get(path)
		)
		expect(changed).toEqual([])
	})
})
