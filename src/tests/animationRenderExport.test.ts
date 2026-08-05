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
 * 3.  unregister で baseline へ完全復帰すること
 * 4.  `onPose` の `frameIndex` が 0 から 1 ずつ進み、 同じ値で複数回呼ばれること
 * 5.  `frameTimeSeconds` が frame ループの `time` と全 frame で一致すること
 * 6.  hook が throw しても global 状態 (interpolation フラグ / scene angle) が復旧すること
 * 6b. 本体と `onEndAnimation` が両方 throw したとき、 本体側の例外が伝播すること
 * 6c. cleanup の 1 段が throw しても、 残りの段が走ること
 * 6d. 自分が開いていない session を cleanup で終わらせないこと
 * 7.  `onPose` の中から `evaluateBasePose` を呼べて、 `Timeline.time` が戻ること
 * 8.  1 と 2 の render 結果で、 生成される mcfunction が byte 単位で違うこと
 *
 * `animationRenderer.ts` は import 連鎖の **module 評価時**に Blockbench global を要求する
 * (= `Dialog` / `BoneAnimator.prototype`)。 global を後から生やす方式では越えられないため、
 * 該当 module を `vi.mock` で差し替えている。
 *
 * ## golden (`fixtures/renderBaselineGolden.json`) の再生成手順
 *
 * golden は **hook 導入前の commit (`a886b10e`) の実装が出した値**であり、 現ブランチのコードから
 * 作ったものではない。 これが 1b を 「回帰ガード」 ではなく 「受け入れ条件の証明」 にしている。
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
	beginRenderingSession,
	endRenderingSession,
	isRenderingSessionActive,
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

	it('1b. hook 未登録の出力は main (= a886b10e) の golden と一致する', async () => {
		const animations = await render(createRenderHarness({ boneUuid: BONE_UUID }))

		expect(serializeAnimations(animations)).toEqual(GOLDEN.animations)
		expect(hashAnimations(animations)).toBe(GOLDEN.hash)
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
