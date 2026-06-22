// keyframe hover popup の mount control
// - 選択中 keyframe (= .keyframe.selected) を mouseover した時に keyframe element の右側に popup mount
// - popup 内は keyframeEasingsPopup.svelte (= 既存 easing UI + XYZ input)
// - mouse が keyframe / popup の両方から離れた時に unmount (= 100ms grace で chatter 防止)

import { registerPatch } from 'blockbench-patch-manager'
import { injectComponent } from 'svelte-patching-tools'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import KeyframeEasingsPopupSvelte from '../svelteComponents/keyframeEasingsPopup.svelte'
import { isFirstKeyframe } from './keyframeEasings'

const POPUP_ID = 'aj-keyframe-easing-popup'
const POPUP_CSS = `
#${POPUP_ID} {
	position: fixed;
	z-index: 9999;
	background: var(--color-back);
	border: 1px solid var(--color-border);
	border-radius: 4px;
	box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
	min-width: 360px;
	max-width: 90vw;
}
`

let unmountCallback: (() => Promise<void>) | null = null
let activeKeyframeUuid: string | undefined = undefined
let activePopupNode: HTMLElement | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

function cancelHide(): void {
	if (hideTimer !== null) {
		clearTimeout(hideTimer)
		hideTimer = null
	}
}

function scheduleHide(): void {
	cancelHide()
	hideTimer = setTimeout(() => {
		hideTimer = null
		void destroyPopup()
	}, 120)
}

async function destroyPopup(): Promise<void> {
	const cb = unmountCallback
	unmountCallback = null
	activeKeyframeUuid = undefined
	if (activePopupNode) {
		activePopupNode.remove()
		activePopupNode = null
	}
	if (cb) {
		try {
			await cb()
		} catch (e) {
			console.warn('[AJ] popup unmount error:', e)
		}
	}
}

function positionPopup(node: HTMLElement, anchor: HTMLElement): void {
	const rect = anchor.getBoundingClientRect()
	const padding = 6
	// 初期配置 = keyframe の右側 + 少し下
	let left = rect.right + padding
	let top = rect.bottom + padding
	const popupRect = node.getBoundingClientRect()
	// 画面右端ではみ出すなら keyframe の左側に flip
	if (left + popupRect.width > window.innerWidth - 4) {
		left = Math.max(4, rect.left - popupRect.width - padding)
	}
	// 画面下端ではみ出すなら上に flip
	if (top + popupRect.height > window.innerHeight - 4) {
		top = Math.max(4, rect.top - popupRect.height - padding)
	}
	node.style.left = `${left}px`
	node.style.top = `${top}px`
}

function findKeyframe(uuid: string): _Keyframe | undefined {
	const anim = Animation.selected
	if (!anim) return undefined
	for (const animator of Object.values(anim.animators ?? {})) {
		for (const channel of ['rotation', 'position', 'scale'] as const) {
			const list = (animator as unknown as Record<string, _Keyframe[] | undefined>)[channel]
			if (!Array.isArray(list)) continue
			for (const kf of list) {
				if (kf.uuid === uuid) return kf
			}
		}
	}
	return undefined
}

async function showPopup(kfElement: HTMLElement): Promise<void> {
	if (!activeProjectIsBlueprintFormat()) return
	const uuid = kfElement.id
	if (!uuid) return
	const kf = findKeyframe(uuid)
	// AJ 仕様 = 左端 (= 同 channel で時間順最初) の keyframe は easing 編集対象外
	if (!kf || !kf.selected || isFirstKeyframe(kf)) return

	// 既に同 keyframe を出してるなら何もしない (= cancel pending hide だけ)
	if (activeKeyframeUuid === uuid && activePopupNode) {
		cancelHide()
		return
	}

	// 別 keyframe の popup が残ってたら破棄してから新規 mount
	await destroyPopup()

	const node = document.createElement('div')
	node.id = POPUP_ID
	node.addEventListener('mouseenter', cancelHide)
	node.addEventListener('mouseleave', scheduleHide)
	document.body.appendChild(node)
	activePopupNode = node
	activeKeyframeUuid = uuid

	unmountCallback = injectComponent({
		component: KeyframeEasingsPopupSvelte,
		props: { selectedKeyframe: kf },
		elementSelector() {
			return node
		},
		postMount() {
			if (activePopupNode === node) {
				positionPopup(node, kfElement)
			}
		},
	})
}

// document-level delegated event
function onMouseOver(e: MouseEvent): void {
	const target = e.target as HTMLElement | null
	if (!target) return
	const kfElement = target.closest<HTMLElement>('.keyframe.selected')
	if (!kfElement) return
	void showPopup(kfElement)
}

function onMouseOut(e: MouseEvent): void {
	const target = e.target as HTMLElement | null
	const related = e.relatedTarget as HTMLElement | null
	if (!target) return
	const fromKeyframe = target.closest<HTMLElement>('.keyframe.selected')
	if (!fromKeyframe) return
	// popup 内 or 同じ keyframe 内なら維持
	if (related?.closest(`#${POPUP_ID}`)) return
	if (related?.closest('.keyframe.selected') === fromKeyframe) return
	scheduleHide()
}

// BB は capture phase で modifier + Arrow を hook してるため、 svelte onkeydown より先に
// document level の capture phase で奪い取り、 popup 内 axis input がフォーカス中なら hijack。
// 倍率は BB NumSlider 踏襲 (= js/interface/actions.ts:1088-1098) :
//   plain=1, Shift=0.25, Ctrl=0.1, Ctrl+Shift=0.025
function getInterval(e: { shiftKey?: boolean; ctrlKey?: boolean }): number {
	if (e.ctrlKey && e.shiftKey) return 0.025
	if (e.ctrlKey) return 0.1
	if (e.shiftKey) return 0.25
	return 1
}

function applyToActiveInput(active: HTMLInputElement, delta: number): void {
	const current = parseFloat(active.value)
	if (!Number.isFinite(current)) return
	const next = Math.round((current + delta) * 10000) / 10000
	active.value = String(next)
	// svelte の bind:value 経路 + oninput callback を起こす
	active.dispatchEvent(new Event('input', { bubbles: true }))
}

function onAxisKeyCapture(e: KeyboardEvent): void {
	if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
	// plain も含めて全部 capture で処理 (= type=text にしたので browser 標準 Arrow は無関係、
	// 全 case で自前 getInterval が必要)
	const active = document.activeElement as HTMLInputElement | null
	if (!active || !active.matches(`#${POPUP_ID} input[data-axis]`)) return

	e.preventDefault()
	e.stopPropagation()
	e.stopImmediatePropagation()

	const step = getInterval(e)
	applyToActiveInput(active, e.key === 'ArrowUp' ? step : -step)
}

function onAxisWheelCapture(e: WheelEvent): void {
	const active = document.activeElement as HTMLInputElement | null
	if (!active || !active.matches(`#${POPUP_ID} input[data-axis]`)) return
	if (e.target !== active) return

	e.preventDefault()
	e.stopPropagation()
	e.stopImmediatePropagation()

	const step = getInterval(e)
	applyToActiveInput(active, e.deltaY < 0 ? step : -step)
}

registerPatch({
	id: 'animated_java:keyframe-easing-popup',

	apply: () => {
		const cssDeletable = Blockbench.addCSS(POPUP_CSS)
		document.addEventListener('mouseover', onMouseOver, true)
		document.addEventListener('mouseout', onMouseOut, true)
		document.addEventListener('keydown', onAxisKeyCapture, true)
		document.addEventListener('wheel', onAxisWheelCapture, { capture: true, passive: false })
		return { cssDeletable }
	},

	revert: ({ cssDeletable }) => {
		document.removeEventListener('mouseover', onMouseOver, true)
		document.removeEventListener('mouseout', onMouseOut, true)
		document.removeEventListener('keydown', onAxisKeyCapture, true)
		document.removeEventListener('wheel', onAxisWheelCapture, true)
		cancelHide()
		void destroyPopup()
		cssDeletable.delete()
	},
})
