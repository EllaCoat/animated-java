/**
 * `renderProjectAnimations` を Blockbench 無しで実走させるための最小 harness。
 *
 * production の render 経路 (`renderProjectAnimations` → `renderAnimation` → `updatePreview` /
 * `getFrame`) をそのまま呼ぶ。 ロジックを test 側へ写さないのが前提なので、 ここで用意するのは
 * **実行時に触られる global だけ**。
 *
 * **前提** : このモジュールは `../../dialogs/exportProgress/exportProgress` /
 * `../../mods/boneAnimatorMod` / `../../outliner/*` / `../../util/minecraftUtil` が
 * `vi.mock` されている test file からのみ使える (= いずれも **module 評価時**に Blockbench の
 * global を要求するため、 global を後から生やす方式では越えられない)。 mock の実体は
 * `animationRenderExport.test.ts` を参照。
 *
 * production では three を Blockbench が runtime 供給する (= plugin は bundle に含めない) が、
 * `matrixWorld` の階層計算を本物で回さないと出力が検証できないため、 harness では実物を
 * `globalThis.THREE` に載せる。 そのため three は **テスト用の devDependency として明示的に
 * 宣言してある** (= `package.json` の `three: ^0.134.0`。 Blockbench 5.1.4 は r129 相当だが、
 * `wintersky` が `^0.134.0` を要求しており、 別 version を足すと three が 2 コピー同居するため
 * 0.134 に揃えた。 harness が使う `Object3D` / `Matrix4` / `Vector3` / `Quaternion` / `Euler` に
 * r129 → r134 の破壊的変更は無い)。
 */
import * as THREE from 'three'

import type { IRenderedAnimation } from '../../systems/animationRenderer'
import type { AnyRenderedNode, IRenderedRig } from '../../systems/rigRenderer'

/** frame ループの刻み幅 (= 1 tick)。 */
const TICK = 0.05

/**
 * animatable node の最小実装。
 *
 * `updatePreviewBase` の `if (!(node.constructor as any).animator) continue` を通すため、
 * static `animator` を持つ必要がある。
 */
export class HarnessBone {
	/** `updatePreviewBase` が見る「この class は animate できるか」のフラグ。 */
	static animator = true

	readonly type = 'bone'
	readonly parent = 'root'
	readonly mesh: THREE.Object3D

	constructor(
		readonly uuid: string,
		readonly name: string
	) {
		this.mesh = new THREE.Object3D()
		this.mesh.name = name
	}

	/** `Animator.showDefaultPose(true)` 相当。 rest pose へ戻す。 */
	resetToRestPose() {
		this.mesh.position.set(0, 0, 0)
		this.mesh.rotation.set(0, 0, 0)
		this.mesh.scale.set(1, 1, 1)
	}

	/**
	 * keyframe 評価相当。 時刻の単純な関数で pose を **絶対値として**書く
	 * (= 相対加算にすると二度呼びで結果が変わり、 production の IK 二度呼びを再現できない)。
	 *
	 * 位置は Blockbench 単位 (= `getNodeMatrix` が 1/16 する) なので、 `y = time * 16` で
	 * 出力側の translation が `time` になる。
	 */
	applyPoseAtTime(time: number) {
		this.mesh.position.set(0, time * 16, 0)
		this.mesh.rotation.set(0, time, 0)
		this.mesh.scale.set(1, 1, 1)
	}
}

/**
 * `renderProjectAnimations` の戻り値を golden 比較用の安定した形へ落とす。
 *
 * **含むもの** : `IRenderedAnimation` の全スカラーフィールド (= `name` / `storage_name` / `uuid` /
 * `loop_delay` / `duration` / `loop_mode` / `tsb_priority`) と、 `IRenderedFrame` /
 * `INodeTransform` の全フィールド (= `matrix` の 16 要素と `decomposed` を含む)。
 * `THREE.Matrix4` / `Vector3` / `Quaternion` はそのまま JSON 化すると three の内部表現
 * (= `_x` 等) に依存するため数値配列へ落とす。 丸めはしない (= bit 単位で比較する)。
 *
 * **含まないもの** : `modified_nodes` の node 本体。 uuid の一覧 (ソート済み) へ縮約しており、
 * node の `type` / `storage_name` / `default_transform` 等は比較対象に入っていない。
 * `hashAnimations` が mix しているのも `Object.keys(modified_nodes)` なので、 それと粒度を
 * 合わせた形 (= node 本体の中身は rig 側の責務で、 animation の render 結果ではないため)。
 *
 * optional フィールドは `undefined` ではなく `null` に正規化する
 * (= JSON 化で key ごと消えて比較が緩くなるのを防ぐため)。
 *
 * **この関数は golden の生成側 (= main worktree) と比較側の両方で使うので、
 * 変更すると既存 golden と一致しなくなる** (= 再生成手順は `animationRenderExport.test.ts` の
 * 冒頭 JSDoc)。
 */
export function serializeAnimations(animations: readonly IRenderedAnimation[]) {
	return animations.map(animation => ({
		name: animation.name,
		storage_name: animation.storage_name,
		uuid: animation.uuid,
		loop_delay: animation.loop_delay,
		duration: animation.duration,
		loop_mode: animation.loop_mode,
		tsb_priority: animation.tsb_priority ?? null,
		modified_nodes: Object.keys(animation.modified_nodes).sort(),
		frames: animation.frames.map(frame => ({
			time: frame.time,
			variants: frame.variants ?? null,
			variants_execute_condition: frame.variants_execute_condition ?? null,
			function: frame.function ?? null,
			function_execute_condition: frame.function_execute_condition ?? null,
			node_transforms: Object.fromEntries(
				Object.entries(frame.node_transforms).map(([uuid, transform]) => [
					uuid,
					{
						pos: transform.pos,
						rot: transform.rot,
						scale: transform.scale,
						head_rot: transform.head_rot,
						matrix: Array.from(transform.matrix.elements),
						decomposed: {
							translation: [
								transform.decomposed.translation.x,
								transform.decomposed.translation.y,
								transform.decomposed.translation.z,
							],
							left_rotation: [
								transform.decomposed.left_rotation.x,
								transform.decomposed.left_rotation.y,
								transform.decomposed.left_rotation.z,
								transform.decomposed.left_rotation.w,
							],
							scale: [
								transform.decomposed.scale.x,
								transform.decomposed.scale.y,
								transform.decomposed.scale.z,
							],
						},
						interpolation: transform.interpolation ?? null,
						function: transform.function ?? null,
						function_execute_condition: transform.function_execute_condition ?? null,
					},
				])
			),
		})),
	}))
}

export interface HarnessOptions {
	/**
	 * bone の uuid。 render 結果を `compileFixture` へ流す場合は、 fixture rig 側の bone uuid
	 * (= `minimalRig.ts` の `BONE_UUID`) と一致させる必要がある。
	 */
	boneUuid?: string
	/** animation 名。 */
	animationName?: string
	/** animation 長 (秒)。 frame 数は `length / 0.05 + 1`。 */
	animationLength?: number
}

/** `renderProjectAnimations` に渡す一式と、 assert 用の参照。 */
export interface RenderHarness {
	/** `renderProjectAnimations(project, rig)` の第 1 引数。 */
	project: ModelProject
	/** 同第 2 引数。 */
	rig: IRenderedRig
	/** 単一の bone。 hook から pose を書き換える対象。 */
	bone: HarnessBone
	/** `Canvas.scene` の実体。 */
	scene: THREE.Scene
	/** frame ループが生成する時刻の一覧 (= assert 用の期待値)。 */
	expectedFrameTimes: number[]
}

/**
 * `renderProjectAnimations` の実行時に触られる global を立てる。
 *
 * 実際に落ちて必要だと分かったものだけを載せている :
 * - `THREE` : `getNodeMatrix` / `correctSceneAngle` / `eulerFromQuaternion`
 * - `Math.radToDeg` : `threeAxisRotationToTwoAxisRotation` (= Blockbench が Math に生やす拡張)
 * - `requestAnimationFrame` : `sleepForAnimationFrame` (= browser global)
 * - `Canvas` / `Timeline` / `Animator` / `Mode` / `Preview` : render ループ本体
 * - `NullObject` / `Group` / `Locator` / `OutlinerElement` : `getAnimatableNodes()`
 *   (= `Interaction` / `TextDisplay` / `Vanilla*Display` は import 経由なので test 側の mock が担当)
 */
export function installRenderGlobals(): void {
	const g = globalThis as any

	// 既存 fixture (`minimalRig.ts`) の `g.THREE ??= { Matrix4: Matrix4Stub }` に負けないよう明示代入する。
	g.THREE = THREE
	if (typeof (Math as any).radToDeg !== 'function') {
		;(Math as any).radToDeg = (radians: number) => THREE.MathUtils.radToDeg(radians)
	}
	if (typeof g.requestAnimationFrame !== 'function') {
		g.requestAnimationFrame = (callback: (time: number) => void) => {
			return setTimeout(() => callback(Date.now()), 0) as unknown as number
		}
	}

	g.Canvas = { scene: new THREE.Scene() }
	g.Timeline = {
		time: 0,
		pause() {},
		setTime(time: number) {
			g.Timeline.time = time
		},
	}
	g.Animator = {
		selected: undefined as unknown,
		showDefaultPose() {
			for (const bone of g.Group.all as HarnessBone[]) bone.resetToRestPose()
		},
		resetLastValues() {},
		preview() {},
	}
	g.Mode = { selected: { id: 'animate' } }
	g.Preview = { all: [] }

	// `getAnimatableNodes()` が読む global 群。 bone は Group.all に置く。
	g.NullObject = { all: [] }
	g.Group = { all: [] as HarnessBone[] }
	g.Locator = { all: [] }
	g.OutlinerElement = { types: {} }
}

/** frame ループ (`animationRenderer.ts` の `for (let time = 0; ...)`) と同じ時刻列。 */
function buildExpectedFrameTimes(length: number): number[] {
	const times: number[] = []
	for (let time = 0; time <= length; time = Math.round((time + TICK) * 20) / 20) {
		times.push(time)
	}
	return times
}

/** `IRenderedRig` の最小形。 render 経路が読むのは `nodes` だけ。 */
function buildHarnessRig(bone: HarnessBone): IRenderedRig {
	const nodes: Record<string, unknown> = {
		[bone.uuid]: {
			type: 'bone',
			name: bone.name,
			storage_name: bone.name,
			uuid: bone.uuid,
			parent: 'root',
			base_scale: 1,
			bounding_box: null,
			configs: { default: {}, variants: {} },
		},
	}
	return {
		nodes: nodes as Record<string, AnyRenderedNode>,
		variants: {},
		textures: {},
		model_export_folder: '',
		texture_export_folder: '',
		includes_custom_models: false,
	} as unknown as IRenderedRig
}

/**
 * `_Animation` 相当の最小実装。 production が実際に呼ぶのは
 * `select()` / `getBoneAnimator()` / `animators` / `effects` / `excluded_nodes` / `length` だけ。
 */
function buildHarnessAnimation(bone: HarnessBone, name: string, length: number) {
	const animator = {
		// `getFrame` の keyframeCache は `animation.animators[uuid]` が truthy でないと
		// 当該 node を丸ごと skip するため、 空でも animator 自体は必要。
		keyframes: [] as unknown[],
		displayFrame() {
			bone.applyPoseAtTime((globalThis as any).Timeline.time as number)
		},
	}
	return {
		name,
		uuid: `animation-${name}`,
		length,
		loop: 'once',
		loop_delay: 0,
		excluded_nodes: [] as Array<{ value: string }>,
		effects: undefined,
		animators: { [bone.uuid]: animator } as Record<string, unknown>,
		select() {},
		getBoneAnimator(node: { uuid: string }) {
			return this.animators[node.uuid]
		},
	}
}

/**
 * global を立て直したうえで、 単一 bone / 単一 animation の harness を組む。
 * 呼ぶたびに scene と node registry を作り直すので、 test 間で状態が漏れない。
 */
export function createRenderHarness(options: HarnessOptions = {}): RenderHarness {
	const boneUuid = options.boneUuid ?? 'harness-bone'
	const animationName = options.animationName ?? 'test_animation'
	const animationLength = options.animationLength ?? 0.5

	installRenderGlobals()
	const g = globalThis as any

	const bone = new HarnessBone(boneUuid, 'body')
	const scene = g.Canvas.scene as THREE.Scene
	scene.add(bone.mesh)
	g.Group.all = [bone]

	const animation = buildHarnessAnimation(bone, animationName, animationLength)
	g.Animator.selected = animation

	return {
		project: { animations: [animation] } as unknown as ModelProject,
		rig: buildHarnessRig(bone),
		bone,
		scene,
		expectedFrameTimes: buildExpectedFrameTimes(animationLength),
	}
}
