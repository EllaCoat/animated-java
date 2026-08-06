import * as crypto from 'node:crypto'
import {
	MAX_PROGRESS,
	PROGRESS,
	PROGRESS_DESCRIPTION,
} from '../dialogs/exportProgress/exportProgress'
import { BONE_INTERPOLATION_ENABLED } from '../mods/boneAnimatorMod'
import { Interaction } from '../outliner/interaction'
import { TextDisplay } from '../outliner/textDisplay'
import { VanillaBlockDisplay } from '../outliner/vanillaBlockDisplay'
import { VanillaItemDisplay } from '../outliner/vanillaItemDisplay'
import { sanitizeStorageKey } from '../util/minecraftUtil'
import { eulerFromQuaternion, roundToNth, scrubUndefined } from '../util/misc'
import {
	beginRenderingSession,
	dispatchBeginAnimation,
	dispatchEndAnimation,
	dispatchPose,
	endRenderingSession,
	hasRenderHooks,
	type RenderAnimationContext,
	shouldDispatchPose,
	withRenderHooksSuppressed,
} from './animationRenderHooks'
import type { AnyRenderedNode, IRenderedRig } from './rigRenderer'
import { sleepForAnimationFrame } from './util'

function getMainPreview() {
	return Preview.all.find(p => p.id === 'main')
}

export function correctSceneAngle() {
	getMainPreview()?.controls.rotateLeft(Math.PI)
	Canvas.scene.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
}

export function restoreSceneAngle() {
	getMainPreview()?.controls.rotateLeft(-Math.PI)
	Canvas.scene.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 0), 0)
}

function getNodeMatrix(node: OutlinerElement, scale: number) {
	const matrixWorld = node.mesh.matrixWorld.clone()
	const pos = new THREE.Vector3().setFromMatrixPosition(matrixWorld).multiplyScalar(1 / 16)
	matrixWorld.setPosition(pos)

	const scaleVec = new THREE.Vector3().setScalar(scale)
	matrixWorld.scale(scaleVec)

	if (node instanceof TextDisplay) {
		matrixWorld.multiply(
			new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, Math.PI, 0, 'XYZ'))
		)
	}

	return matrixWorld
}

function getDecomposedTransformation(matrix: THREE.Matrix4) {
	const translation = new THREE.Vector3()
	const leftRotation = new THREE.Quaternion()
	const scale = new THREE.Vector3()
	matrix.decompose(translation, leftRotation, scale)
	return { translation, left_rotation: leftRotation, scale }
}

function threeAxisRotationToTwoAxisRotation(rot: THREE.Quaternion): ArrayVector2 {
	const euler = new THREE.Euler().setFromQuaternion(rot, 'YXZ')
	return [Math.radToDeg(-euler.x), Math.radToDeg(-euler.y) + 180]
}

export interface INodeTransform {
	matrix: THREE.Matrix4
	decomposed: {
		translation: THREE.Vector3
		left_rotation: THREE.Quaternion
		scale: THREE.Vector3
	}
	pos: ArrayVector3
	rot: ArrayVector3
	scale: ArrayVector3
	// The two-axis (entity head) rotation of the node.
	head_rot: ArrayVector2
	interpolation?: 'step' | 'pre-post'

	function?: string
	function_execute_condition?: string
}

export interface IRenderedFrame {
	time: number
	node_transforms: Record<string, INodeTransform>
	/** A list of Variants (by UUID) to apply this frame */
	variants?: string[]
	/** The condition to check before applying variants */
	variants_execute_condition?: string
	/** A mcfunction to run as the root on this frame. (Supports MCB syntax) */
	function?: string
	/** The condition to check before running the function */
	function_execute_condition?: string
}

export interface IRenderedAnimation {
	name: string
	/** A sanitized version of {@link IRenderedAnimation.name} that is safe to use as a key in a storage object. */
	storage_name: string
	uuid: string
	loop_delay: number
	frames: IRenderedFrame[]
	/**
	 * Duration of the animation in ticks (AKA frames). Same as animation.frames.length
	 */
	duration: number
	loop_mode: 'loop' | 'once' | 'hold'
	/**
	 * Nodes that were modified by the animation
	 */
	modified_nodes: Record<string, AnyRenderedNode>
	/**
	 * TSB Optimized Export only : load priority bucket for the per-bp queue (Phase B-1.5 / B-1.6).
	 * `immediate` を選んだアニメは on_load 直後に variants と並んで即展開される。 default `low`。
	 */
	tsb_priority?: 'immediate' | 'high' | 'low'
}

let lastAnimation: _Animation | undefined
interface LastFrameCacheItem {
	matrix: THREE.Matrix4
	keyframe?: _Keyframe
}
let lastFrameCache = new Map<string, LastFrameCacheItem>()
/**
 * Map of node UUIDs to a map of times to keyframes
 */
let keyframeCache = new Map<string, Map<number, _Keyframe | undefined>>()
let excludedNodesCache = new Set<string>()
let nodeCache = new Map<string, OutlinerElement>()
/**
 * hook context の animation 単位部分。 frame ごとに作り直さないよう `renderAnimation` が 1 回だけ組み立て、
 * `updatePreview` の wrapper が読む。 session 非 active なら dispatch されないので stale でも害はない。
 */
let currentRenderContext: RenderAnimationContext | undefined

/** animation の除外ノード uuid 集合を作る。 `getFrame` の cache と hook context の両方から使う。 */
function collectExcludedNodeUuids(animation: _Animation): Set<string> {
	return new Set(animation.excluded_nodes ? animation.excluded_nodes.map(b => b.value) : [])
}

export function getFrame(
	animation: _Animation,
	nodeMap: IRenderedRig['nodes'],
	time = 0,
	frameIndex: number
): IRenderedFrame {
	const frame: IRenderedFrame = {
		time,
		node_transforms: {},
		...getVariantKeyframe(animation, time),
		...getFunctionKeyframe(animation, time),
	}

	if (lastAnimation !== animation) {
		lastAnimation = animation
		lastFrameCache = new Map()
		keyframeCache = new Map()
		for (const uuid of Object.keys(nodeMap)) {
			const animator: GeneralAnimator | undefined = animation.animators[uuid]
			if (!animator) continue
			const keyframeMap = animator.keyframes
				? new Map(animator.keyframes.map(kf => [kf.time, kf]))
				: new Map<number, _Keyframe>()
			keyframeCache.set(uuid, keyframeMap)
		}
		excludedNodesCache = collectExcludedNodeUuids(animation)
		nodeCache = new Map()
		for (const node of getAnimatableNodes()) {
			nodeCache.set(node.uuid, node)
		}
	}

	for (const [uuid, node] of Object.entries(nodeMap)) {
		const outlinerNode = nodeCache.get(uuid)
		if (!outlinerNode) continue
		if (excludedNodesCache.has(uuid)) continue
		const keyframes = keyframeCache.get(uuid)
		if (!keyframes) continue
		const keyframe = keyframes.get(time)
		// keyframeCache のキーは格子に正規化済みなので、引く側も再スナップしないと浮動小数誤差で外れる
		const prevKeyframe = keyframes.get(roundToNth(time - 0.05, 20))
		const lastFrame = lastFrameCache.get(uuid)

		const transform = {} as INodeTransform

		switch (node.type) {
			case 'text_display':
			case 'item_display':
			case 'block_display':
			case 'bone': {
				transform.matrix = getNodeMatrix(outlinerNode, node.base_scale)
				// Inherit instant interpolation from parent
				if (node.parent && node.parent !== 'root') {
					const parentKeyframes = keyframeCache.get(node.parent)
					const parentKeyframe = parentKeyframes?.get(time)
					const prevParentKeyframe = parentKeyframes?.get(roundToNth(time - 0.05, 20))
					if (parentKeyframe?.interpolation === 'step') {
						transform.interpolation = 'step'
					} else if (prevParentKeyframe?.data_points.length === 2) {
						transform.interpolation = 'pre-post'
					}
				}
				// Only add the frame if the matrix has changed, this is the first frame, or there is an interpolation change.
				if (
					lastFrame &&
					lastFrame.matrix.equals(transform.matrix) &&
					transform.interpolation == undefined
				)
					continue
				// Instant interpolation
				if (keyframe?.interpolation === 'step') {
					transform.interpolation = 'step'
				} else if (prevKeyframe?.data_points.length === 2) {
					transform.interpolation = 'pre-post'
					updatePreview(animation, time + 0.001, frameIndex)
					const postMatrix = getNodeMatrix(outlinerNode, node.base_scale)
					transform.matrix = postMatrix
					updatePreview(animation, time, frameIndex)
				}

				lastFrameCache.set(uuid, { matrix: transform.matrix, keyframe })
				break
			}
			case 'interaction':
			case 'locator': {
				transform.matrix = getNodeMatrix(outlinerNode, 1)
				// // Only add the frame if the matrix has changed, or this is the first frame
				// if (lastFrame && lastFrame.matrix.equals(matrix)) continue
				if (keyframe) {
					transform.function = keyframe.function
					transform.function_execute_condition = keyframe.execute_condition
					lastFrameCache.set(uuid, { matrix: transform.matrix, keyframe })
				} else if (lastFrame?.keyframe) {
					const repeat = lastFrame.keyframe.repeat
					const frequency = lastFrame.keyframe.repeat_frequency
					if (repeat && frequency && Math.round(time * 20) % frequency === 0) {
						transform.function = lastFrame.keyframe.function
						transform.function_execute_condition = lastFrame.keyframe.execute_condition
					}
				}
				// lastFrameCache.set(uuid, { matrix, keyframe })
				break
			}
			case 'null_object':
				updatePreview(animation, time, frameIndex)
			case 'camera':
			case 'struct': {
				transform.matrix = getNodeMatrix(outlinerNode, 1)
				// Only add the frame if the matrix has changed, or this is the first frame
				if (lastFrame?.matrix.equals(transform.matrix)) continue
				lastFrameCache.set(uuid, { matrix: transform.matrix, keyframe })
				break
			}
		}

		const pos = new THREE.Vector3()
		const rot = new THREE.Quaternion()
		const scale = new THREE.Vector3()
		transform.matrix.decompose(pos, rot, scale)
		transform.decomposed = getDecomposedTransformation(transform.matrix)

		if (node.type === 'locator' || node.type === 'camera' || node.type === 'interaction') {
			node.max_distance = Math.max(node.max_distance, pos.length())
		}

		transform.pos = [pos.x, pos.y, pos.z]
		transform.rot = eulerFromQuaternion(rot).toArray()
		transform.scale = [scale.x, scale.y, scale.z]
		transform.head_rot = threeAxisRotationToTwoAxisRotation(rot)

		frame.node_transforms[uuid] = transform
	}

	return frame
}

function getVariantKeyframe(
	animation: _Animation,
	time: number
): Pick<IRenderedFrame, 'variants' | 'variants_execute_condition'> {
	const variantKeyframes = animation.animators.effects?.variant as _Keyframe[]
	if (variantKeyframes) {
		const kf = variantKeyframes.find(kf => kf.time === time)
		if (kf) {
			// REVIEW - Variant keyframes do not support multiple variants yet.
			const variant = kf.variant?.uuid
			if (variant) {
				return scrubUndefined({
					variants: [variant],
					variants_execute_condition: kf.execute_condition?.trim(),
				})
			}
		}
	}
	return {}
}

function getFunctionKeyframe(
	animation: _Animation,
	time: number
): Pick<IRenderedFrame, 'function' | 'function_execute_condition'> {
	const functionKeyframes = animation.animators.effects?.function as _Keyframe[]
	if (functionKeyframes) {
		const kf = functionKeyframes.find(kf => kf.time === time)
		if (kf) {
			return scrubUndefined({
				function: kf.function?.trim(),
				function_execute_condition: kf.execute_condition?.trim(),
			})
		}
	}
	return {}
}

/**
 * keyframe pose を scene へ確定させるだけの素の評価。 hook を一切呼ばない。
 * effects の表示は含まない (= hook が pose を書き換える前に effects に読ませないため wrapper 側に置く)。
 */
function updatePreviewBase(animation: _Animation, time: number) {
	Timeline.time = time
	Animator.showDefaultPose(true)
	const nodes: OutlinerNode[] = getAnimatableNodes()
	for (const node of nodes) {
		if (!(node.constructor as any).animator) continue
		Animator.resetLastValues()
		animation.getBoneAnimator(node)!.displayFrame()
	}
	Animator.resetLastValues()
	Canvas.scene.updateMatrixWorld(true)
}

export function updatePreview(animation: _Animation, time: number, frameIndex: number) {
	updatePreviewBase(animation, time)
	// hook は scene の node pose を直接書き換えるので、 pose 確定後・ effects が読む前に挟む
	if (shouldDispatchPose() && currentRenderContext) {
		dispatchPose({
			...currentRenderContext,
			frameIndex,
			frameTimeSeconds: frameIndex / 20,
			timeSeconds: time,
		})
	}
	if (animation.effects) animation.effects.displayFrame()
}

/** 例外を 1 件だけ保持する箱。 2 件目以降は `console.warn` へ落とす。 */
interface IErrorSlot {
	failed: boolean
	error?: unknown
}

function createErrorSlot(): IErrorSlot {
	return { failed: false }
}

/**
 * cleanup の 1 段。 throw しても後続の段を止めず、 例外は `slot` に集める
 * (= 1 つの復元失敗が他の復元を巻き添えにしないため)。
 */
function runCleanupStep(slot: IErrorSlot, step: () => void) {
	try {
		step()
	} catch (error) {
		if (slot.failed) console.warn(error)
		else {
			slot.failed = true
			slot.error = error
		}
	}
}

/**
 * 本体と cleanup の例外を、 **本体優先**で送出する。
 * 本体が throw していたら cleanup 側の例外は `console.warn` に落とす (= 元の例外を上書きしない)。
 */
function throwPreferringBody(body: IErrorSlot, cleanup: IErrorSlot) {
	if (body.failed) {
		if (cleanup.failed) console.warn(cleanup.error)
		throw body.error
	}
	if (cleanup.failed) throw cleanup.error
}

/**
 * frame ループが生成する sample 数の上限。 1 sample = 1 tick なので 100,000 で約 83 分ぶんあり、
 * 現実的な animation 長は十分に超えている。 `animation.length` が壊れた値 (= `Infinity` 等) の
 * ときに時刻列が際限なく伸びるのを止めるためだけの安全弁。
 */
const MAX_RENDER_SAMPLES = 100_000

function renderAnimation(animation: _Animation, rig: IRenderedRig) {
	const rendered = {
		name: animation.name,
		storage_name: sanitizeStorageKey(animation.name),
		uuid: animation.uuid,
		loop_delay: Number(animation.loop_delay) || 0,
		frames: [],
		duration: 0,
		loop_mode: animation.loop,
		modified_nodes: {},
		tsb_priority: animation.tsb_priority,
	} as IRenderedAnimation
	animation.select()

	const includedNodes = new Set<string>()

	// frame ループが訪れる時刻の列。 **ループ本体もこの配列を回す** (= context の
	// `renderSampleCount` と実際の frame 数を同じ配列から取るため)。 `animation.length` から
	// 別式で数え直すと `roundToNth` の丸めと食い違って off-by-one が出る。
	const sampleTimes: number[] = []
	for (let time = 0; time <= animation.length; time = roundToNth(time + 0.05, 20)) {
		if (sampleTimes.length >= MAX_RENDER_SAMPLES) {
			console.warn(
				`Animation '${animation.name}' exceeds the render sample limit (${MAX_RENDER_SAMPLES}); truncating. Check the animation length (${animation.length}).`
			)
			break
		}
		sampleTimes.push(time)
	}

	currentRenderContext = {
		animation,
		rig,
		excludedNodeUuids: collectExcludedNodeUuids(animation),
		animationLengthSeconds: animation.length,
		renderSampleCount: sampleTimes.length,
		// loop 情報は `animation` から読み直さず `rendered` を経由する。 `animation.select()` は
		// `select_animation` を同期 dispatch するため、 listener が loop 設定を書き換えると
		// 「context = select 後の新値 / datapack meta = select 前の旧値」 に割れてしまう
		loopMode: rendered.loop_mode,
		loopDelayFrames: rendered.loop_delay,
		evaluateBasePose(timeSeconds: number) {
			const previousTime = Timeline.time
			try {
				// この閉包は onPose の中から呼ばれうる (= 再入経路) ため、 防御として抑制下で回す
				withRenderHooksSuppressed(() => {
					updatePreviewBase(animation, timeSeconds)
					updatePreviewBase(animation, timeSeconds) // IK doesn't work unless I call this twice for some reason...
				})
			} finally {
				Timeline.time = previousTime
			}
		},
	}
	const bodyError = createErrorSlot()
	const cleanupError = createErrorSlot()
	// dispatchBeginAnimation が部分失敗したときの onEndAnimation は registry 側の unwind が
	// 送るため、 この flag で cleanup 側の dispatchEndAnimation と二重にならないようにする
	let animationBegun = false
	try {
		dispatchBeginAnimation(currentRenderContext)
		animationBegun = true

		let frameIndex = 0
		for (const time of sampleTimes) {
			updatePreview(animation, time, frameIndex)
			updatePreview(animation, time, frameIndex) // IK doesn't work unless I call this twice for some reason...
			const frame: IRenderedFrame = getFrame(animation, rig.nodes, time, frameIndex)
			Object.keys(frame.node_transforms).forEach(n => includedNodes.add(n))
			rendered.frames.push(frame)
			frameIndex++
		}
		// dev guard : hook へ渡した `renderSampleCount` と実際の frame 数がずれていたら契約違反。
		// 出力自体は壊さないので throw はせず warn だけ出す。
		// **現在の制御フローでは発火しない** (= ループは `sampleTimes` を最後まで回し、 各周で
		// 必ず 1 frame push する)。 将来ループ本体に `continue` 等が入ったときの保険として置いている。
		if (rendered.frames.length !== sampleTimes.length) {
			console.warn(
				`Render sample count mismatch on animation '${animation.name}': context reported ${sampleTimes.length}, but ${rendered.frames.length} frames were rendered.`
			)
		}
	} catch (error) {
		bodyError.failed = true
		bodyError.error = error
	}

	runCleanupStep(cleanupError, () => {
		if (animationBegun) dispatchEndAnimation()
	})
	runCleanupStep(cleanupError, () => {
		// dispatchEndAnimation の成否に関わらず context は必ず捨てる
		currentRenderContext = undefined
	})
	throwPreferringBody(bodyError, cleanupError)

	rendered.duration = rendered.frames.length
	rendered.modified_nodes = Object.fromEntries(
		Array.from(includedNodes).map(uuid => [uuid, rig.nodes[uuid]])
	)

	return rendered
}

export function hashAnimations(animations: IRenderedAnimation[]) {
	const hash = crypto.createHash('sha256')
	for (const animation of animations) {
		hash.update('anim;' + animation.name)
		hash.update(';' + animation.duration.toString())
		hash.update(';' + animation.loop_mode)
		// tsb_priority を mix しないと priority のみ変更時に hash 同一判定で reload-skip 誤判定が起きる
		hash.update(';' + (animation.tsb_priority ?? 'low'))
		hash.update(';' + Object.keys(animation.modified_nodes).join(';'))
		for (const frame of animation.frames) {
			hash.update(';' + frame.time.toString())
			for (const [uuid, node] of Object.entries(frame.node_transforms)) {
				hash.update(';' + uuid)
				// matrix は pos / rot / scale の上位互換 (= それらは Matrix4.decompose の出力で、
				// shear と right rotation を表現できない)。 一方 datapack compiler は matrix 全体を
				// 使う (= TSB 経路は decomposeTsb の SVD、 純正経路は 16 要素をそのまま書き出す) ため、
				// 派生値だけを mix すると 「出力は変わったのに hash は同じ」 = reload-skip の誤判定が起きる。
				// 情報量が最大なので他のどの派生値よりも先に混ぜる。
				hash.update(';' + node.matrix.elements.join(';'))
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

export function getAnimatableNodes(): OutlinerElement[] {
	return [
		...NullObject.all,
		...Group.all,
		...Locator.all,
		...Interaction.all,
		...TextDisplay.all,
		...VanillaBlockDisplay.all,
		...VanillaItemDisplay.all,
		// @ts-expect-error - Broken BB types
		...(OutlinerElement.types.camera ? OutlinerElement.types.camera.all : []),
	]
}

export async function renderProjectAnimations(project: ModelProject, rig: IRenderedRig) {
	// Clear the cache
	lastAnimation = undefined
	lastFrameCache = new Map()
	keyframeCache = new Map()
	excludedNodesCache = new Set()
	nodeCache = new Map()

	// console.time は保護区間の外に置く。 cleanup の console.timeEnd が無条件に走るため、
	// ここを try の中にすると time 未実行のまま timeEnd が呼ばれる経路ができる
	console.time('Rendering animations took')
	let selectedAnimation: _Animation | undefined
	let currentTime = 0
	const animations: IRenderedAnimation[] = []
	let sceneAngleCorrected = false

	const bodyError = createErrorSlot()
	const cleanupError = createErrorSlot()
	// この呼び出しが session を開いたかどうか。 開いた側だけが閉じる
	// (= 並行に走ったもう 1 本の cleanup が、 こちらの session を終わらせないため)
	let sessionStarted = false

	// 途中で例外が出ても bone interpolation / scene angle / 選択中 animation を必ず入口の状態へ戻す。
	// interpolation フラグを倒すのは try に入ってから (= 直後の PROGRESS 系 subscriber が throw しても
	// false のまま取り残されないようにするため)
	try {
		BONE_INTERPOLATION_ENABLED.set(false)

		PROGRESS_DESCRIPTION.set('Rendering Animations...')
		PROGRESS.set(0)
		MAX_PROGRESS.set(project.animations.length)

		Timeline.pause()
		// Save selected animation
		if (Mode.selected.id === 'animate') {
			selectedAnimation = Animator.selected
			currentTime = Timeline.time
		}
		// 退避より後に session を開く (= hook の onBeginRendering が選択状態を書き換えても、
		// 書き換え後の状態を「元の状態」として保存しないため)。
		// hook が 1 つも無いときは session 自体を張らない (= 従来の挙動と完全に同一にするため)
		if (hasRenderHooks()) {
			beginRenderingSession()
			sessionStarted = true
		}

		// correctSceneAngle が 2 行の途中で throw しても復元を試みられるよう、 先にフラグを立てる
		sceneAngleCorrected = true
		correctSceneAngle()
		for (const animation of project.animations) {
			animations.push(renderAnimation(animation, rig))
			PROGRESS.set(PROGRESS.get() + 1)
			await sleepForAnimationFrame()
		}
	} catch (error) {
		bodyError.failed = true
		bodyError.error = error
	}

	// 選択状態の復元先は cleanup 開始時点の Mode で 1 回だけ判定し、 各 step で使い回す
	const animationToRestore = Mode.selected.id === 'animate' ? selectedAnimation : undefined
	const restoreDefaultPose = !animationToRestore && Mode.selected.id === 'edit'

	// session の終了は Animator.preview() (= display_animation_frame の発火) より前に済ませる
	runCleanupStep(cleanupError, () => {
		if (sessionStarted) endRenderingSession()
	})
	runCleanupStep(cleanupError, () => {
		if (sceneAngleCorrected) restoreSceneAngle()
	})
	runCleanupStep(cleanupError, () => BONE_INTERPOLATION_ENABLED.set(true))
	// Restore selected animation (= 1 つが throw しても残りが走るよう操作ごとに分ける)
	runCleanupStep(cleanupError, () => {
		if (animationToRestore) animationToRestore.select()
	})
	runCleanupStep(cleanupError, () => {
		if (animationToRestore) Timeline.setTime(currentTime)
	})
	runCleanupStep(cleanupError, () => {
		if (animationToRestore) Animator.preview()
	})
	runCleanupStep(cleanupError, () => {
		if (restoreDefaultPose) Animator.showDefaultPose()
	})
	runCleanupStep(cleanupError, () => console.timeEnd('Rendering animations took'))

	// 元の例外を cleanup の例外で上書きしない
	throwPreferringBody(bodyError, cleanupError)

	console.log('Animations:', animations)
	return animations
}
