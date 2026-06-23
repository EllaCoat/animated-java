import { registerPatch } from 'blockbench-patch-manager'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'

// timeline に乗るボーン数が多い blueprint で、 ドラッグ box-select が縦に長すぎて
// 使いづらい問題への対応。 frame 範囲を数値入力し、 表示中の全 animator の keyframe を
// 縦断的に一括選択する (= 既存 keyframe_column_select の time-range 版)。

const ACTION_ID = 'animated_java:select_keyframes_in_range'

function selectKeyframesInRange(startFrame: number, endFrame: number, fps: number) {
	if (endFrame < startFrame) [startFrame, endFrame] = [endFrame, startFrame]
	// frame 境界上の keyframe を浮動小数点誤差込みで確実に含める (半 frame 未満の許容)
	const eps = 0.4 / fps
	const t1 = startFrame / fps - eps
	const t2 = endFrame / fps + eps

	Undo.initSelection({ timeline: true })

	for (const kf of Timeline.selected.slice()) kf.selected = false
	Timeline.selected.empty()

	// 非表示 channel は box-select と同じく Timeline.vue.channels で弾く
	const channels = (Timeline.vue as any).channels as Record<string, boolean>
	// action.condition で Animator.open && !!Animation.selected を担保しているが、
	// プロジェクト切替直後等で Timeline.animators が undefined のエッジケース防御 (= reviewer 指摘 C3)
	for (const animator of Timeline.animators ?? []) {
		for (const kf of animator.keyframes as _Keyframe[]) {
			if (kf.time >= t1 && kf.time <= t2 && channels[kf.channel] !== false) {
				kf.selected = true
				Timeline.selected.push(kf)
			}
		}
	}

	updateKeyframeSelection()
	Undo.finishSelection('Select keyframes in frame range')
}

function openDialog() {
	const animation = Animation.selected
	if (!animation) return
	// AJ blueprint は snapping=20 (= 20fps)。 動的に拾って frame ↔ 秒を変換
	const fps = (animation as any).snapping || 20
	const lengthFrame = Math.round(animation.length * fps)
	const currentFrame = Math.round(Timeline.time * fps)

	new Dialog(ACTION_ID, {
		title: 'Select Keyframes in Frame Range',
		form: {
			start: {
				label: 'Start frame',
				type: 'number',
				value: 0,
				min: 0,
				max: lengthFrame,
				step: 1,
			},
			end: {
				label: 'End frame',
				type: 'number',
				value: currentFrame || lengthFrame,
				min: 0,
				max: lengthFrame,
				step: 1,
			},
		},
		onConfirm(result: { start: number; end: number }) {
			selectKeyframesInRange(Number(result.start), Number(result.end), fps)
			this.hide()
		},
	}).show()
}

registerPatch({
	id: 'animated_java:select-keyframes-in-range',
	apply() {
		const action = new Action(ACTION_ID, {
			name: 'Select Keyframes in Range',
			description:
				'Select all visible keyframes within a frame range (vertical span across the animators shown in the timeline).',
			icon: 'select_all',
			category: 'animation',
			condition: () =>
				activeProjectIsBlueprintFormat() && Animator.open && !!Animation.selected,
			click() {
				openDialog()
			},
		})
		if (Toolbars.timeline) Toolbars.timeline.add(action, -1)
		return { action }
	},
	revert({ action }: { action: Action }) {
		if (Toolbars.timeline) Toolbars.timeline.remove(action)
		action.delete()
	},
})
