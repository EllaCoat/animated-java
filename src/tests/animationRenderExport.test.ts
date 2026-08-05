/**
 * production の `renderProjectAnimations` を Blockbench 無しで実走させ、 render hook 経路が
 * 実際に export 出力へ効くことを機械的に固定する。
 *
 * 確認するのは :
 * 1. hook 未登録時の出力が決定的であること (= baseline)
 * 2. hook 登録で `node_transforms` と `hashAnimations` が変わること
 * 3. unregister で baseline へ完全復帰すること
 * 4. `onPose` の `frameIndex` が 0 から 1 ずつ進み、 同じ値で複数回呼ばれること
 * 5. `frameTimeSeconds` が frame ループの `time` と全 frame で一致すること
 * 6. hook が throw しても global 状態 (interpolation フラグ / scene angle) が復旧すること
 * 7. `onPose` の中から `evaluateBasePose` を呼べて、 `Timeline.time` が戻ること
 * 8. 1 と 2 の render 結果で、 生成される mcfunction が byte 単位で違うこと
 *
 * `animationRenderer.ts` は import 連鎖の **module 評価時**に Blockbench global を要求する
 * (= `Dialog` / `BoneAnimator.prototype`)。 global を後から生やす方式では越えられないため、
 * 該当 module を `vi.mock` で差し替えている。
 */
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
	RenderHookError,
	registerRenderHooks,
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
import { createRenderHarness, type RenderHarness } from './fixtures/renderHarness'

/** hook が pose を書き換えるときに足す回転量 (rad)。 baseline と確実に差が出る値。 */
const HOOK_ROTATION = 0.25

const HOOK_ID = 'synthetic-physics'

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

describe('renderProjectAnimations - hook 経路の実走', () => {
	beforeEach(() => {
		// production が毎 render で戻り値全体を console.log するため、 出力を抑える。
		vi.spyOn(console, 'log').mockImplementation(() => {})
		unregisterRenderHooks(HOOK_ID)
	})

	afterEach(() => {
		unregisterRenderHooks(HOOK_ID)
		vi.restoreAllMocks()
	})

	it('1. hook 未登録の出力は決定的 (= 2 回走らせて完全一致)', async () => {
		const first = await render(createRenderHarness({ boneUuid: BONE_UUID }))
		const second = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		expect(first[0].frames.length).toBeGreaterThan(1)
		expect(extractBoneTransforms(first)).toEqual(extractBoneTransforms(second))
		expect(hashAnimations(first)).toBe(hashAnimations(second))
	})

	it('2. hook を登録すると node_transforms と hash が変わる', async () => {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, {
			onPose() {
				// hook は scene の node pose を直接書き換える契約。
				// `getFrame` が読むのは matrixWorld なので、 書き換え後に再計算まで行う。
				harness.bone.mesh.rotation.x += HOOK_ROTATION
				globals().Canvas.scene.updateMatrixWorld(true)
			},
		})
		const hooked = await render(harness)

		expect(hooked[0].frames.length).toBe(baseline[0].frames.length)
		expect(extractBoneTransforms(hooked)).not.toEqual(extractBoneTransforms(baseline))
		expect(hashAnimations(hooked)).not.toBe(hashAnimations(baseline))

		// baseline は X 回転ゼロ、 hook 後は X 回転が乗る。
		// `rot` は `eulerFromQuaternion` 由来で **度数法かつ x の符号反転済み** なうえ、
		// scene 側の 180 度補正と合成されるため、 rad の生値とは一致しない。
		// ここで見たいのは「X 軸成分が 0 から明確に離れたか」なので大きさで判定する。
		const baselineRot = baseline[0].frames[1].node_transforms[BONE_UUID].rot
		const hookedRot = hooked[0].frames[1].node_transforms[BONE_UUID].rot
		expect(baselineRot[0]).toBeCloseTo(0, 9)
		expect(Math.abs(hookedRot[0])).toBeGreaterThan(10)
	})

	it('3. unregister すると baseline へ完全復帰する', async () => {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, {
			onPose() {
				harness.bone.mesh.rotation.x += HOOK_ROTATION
				globals().Canvas.scene.updateMatrixWorld(true)
			},
		})
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
})

describe('renderProjectAnimations - datapack までの byte 差分', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		unregisterRenderHooks(HOOK_ID)
	})

	afterEach(() => {
		unregisterRenderHooks(HOOK_ID)
		vi.restoreAllMocks()
	})

	/** hook 無し / 有りの 2 種類の render 結果を作る。 */
	async function renderBaselineAndHooked() {
		const baseline = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		const harness = createRenderHarness({ boneUuid: BONE_UUID })
		registerRenderHooks(HOOK_ID, {
			onPose() {
				harness.bone.mesh.rotation.x += HOOK_ROTATION
				globals().Canvas.scene.updateMatrixWorld(true)
			},
		})
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
