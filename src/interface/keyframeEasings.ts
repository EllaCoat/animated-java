import { registerPatch } from 'blockbench-patch-manager'
import { injectComponent } from 'svelte-patching-tools'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import KeyframeEasingsSvelte from '../svelteComponents/keyframeEasings.svelte'
import EVENTS from '../util/events'

export function isFirstKeyframe(kf: _Keyframe) {
	return (
		kf.animator.keyframes
			.filter(k => k.channel === kf.channel)
			.sort((a, b) => a.time - b.time)[0] === kf
	)
}

let unmountCallback: (() => Promise<void>) | null = null
let mountedKeyframeUuid: string | undefined = undefined
let isUpdating = false
let updateQueued = false

// 既存 AJ は currentUpdatePromise.then(updatePanel) で再帰 Promise を積み上げてて、
// Animate 画面切替の polling や Animator.preview() の self-feeding event 連発時に
// microtask queue 飽和 → BB freeze する致命脆弱性があった。
// 再帰廃止 + isUpdating flag + updateQueued の coalesce ループに置き換え、
// 同 uuid 選択中は panel を unmount/remount せず state 維持。
const updatePanel = async () => {
	if (isUpdating) {
		updateQueued = true
		return
	}

	isUpdating = true
	try {
		do {
			updateQueued = false

			let selectedKeyframe: _Keyframe | undefined
			try {
				selectedKeyframe = activeProjectIsBlueprintFormat()
					? Timeline.selected.at(0)
					: undefined
			} catch {
				// Animate 画面切替時の race で Timeline 未初期化を踏むケースを吸収
				selectedKeyframe = undefined
			}

			const shouldMount = !!(selectedKeyframe && !isFirstKeyframe(selectedKeyframe))
			const nextUuid = shouldMount ? selectedKeyframe!.uuid : undefined

			// 同 uuid なら panel 保持 (= state 維持、 再 mount なし)
			if (nextUuid === mountedKeyframeUuid) continue

			const unmount = unmountCallback
			unmountCallback = null
			mountedKeyframeUuid = undefined
			await unmount?.()

			if (!shouldMount || !selectedKeyframe) continue

			await new Promise<void>(resolve => {
				unmountCallback = injectComponent({
					component: KeyframeEasingsSvelte,
					props: { selectedKeyframe },
					elementSelector() {
						return Panels.keyframe.node
					},
					postMount() {
						mountedKeyframeUuid = nextUuid
						resolve()
					},
				})
			})
		} while (updateQueued)
	} catch (e) {
		console.warn('[AJ] updatePanel error:', e)
	} finally {
		isUpdating = false
	}
}

registerPatch({
	id: 'animated_java:mounted-svelte/keyframe-easings',
	apply() {
		const unsub = EVENTS.UPDATE_KEYFRAME_SELECTION.subscribe(() => void updatePanel())

		return { unsub }
	},

	async revert({ unsub }) {
		unsub()
		await unmountCallback?.()
	},
})
