// keyframe hover popup の mount control
// - 選択中 keyframe (= .keyframe.selected) を mouseover した時に keyframe element の右側に popup mount
// - popup 内は keyframeEasingsPopup.svelte (= 既存 easing UI + XYZ input)
// - mouse が keyframe / popup の両方から離れた時に unmount (= 100ms grace で chatter 防止)
// - blockbench-anim-ux (= 別 plugin) が居る場合は popout 子窓内でも動作する (= window.AnimUX 経由)

import { registerPatch } from 'blockbench-patch-manager'
import { injectComponent } from 'svelte-patching-tools'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import KeyframeEasingsPopupSvelte from '../svelteComponents/keyframeEasingsPopup.svelte'
import { isFirstKeyframe } from '../panels/easings/easings.svelte'

// blockbench-anim-ux (= sibling plugin) が公開する optional API。
// 居ない場合は素の document.addEventListener にフォールバックする。
type AnimUxExternal = {
	version: string
	addDocumentListener(
		type: string,
		fn: EventListenerOrEventListenerObject,
		opts?: boolean | AddEventListenerOptions,
	): () => void
	getActivePopoutDocument(): Document | null
}

function getAnimUx(): AnimUxExternal | undefined {
	return (window as unknown as { AnimUX?: AnimUxExternal }).AnimUX
}

// 親 document に直登録 + 必要なら popout 子窓にも attach する helper。
// anim_ux 未 install / 旧 version (= addDocumentListener 未対応) でも害なく degrade する。
function attachDocListener(
	type: string,
	fn: EventListenerOrEventListenerObject,
	opts?: boolean | AddEventListenerOptions,
): () => void {
	const animUx = getAnimUx()
	if (animUx?.addDocumentListener) {
		try {
			return animUx.addDocumentListener(type, fn, opts)
		} catch (e) {
			console.warn('[AJ] AnimUX.addDocumentListener failed, fallback to document', e)
		}
	}
	document.addEventListener(type, fn, opts)
	return (): void => {
		try {
			document.removeEventListener(type, fn, opts as boolean | EventListenerOptions | undefined)
		} catch {
			/* noop */
		}
	}
}

const POPUP_ID = 'aj-keyframe-easing-popup'
const POPUP_CSS_ID = 'aj-keyframe-easing-popup-css'
// svelte component の <style> は svelte-patching-tools esbuild plugin 経由で Blockbench.addCSS() に変換される
// (= node_modules/svelte-patching-tools/dist/esbuildPlugin.js:118)。 addCSS は親 document.head 固定なので
// (= js/api.ts:311)、 anim_ux popout で開いた子窓には届かない。 popup の内部レイアウト CSS をここに
// 統合して ensurePopupCssIn で子窓に確実に inject、 cascade で svelte 側の同 selector に勝つ (= id selector で
// specificity も上)。 親 document 上では svelte CSS と同 selector で重複するが、 cascade 順序的に問題なし。
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
#${POPUP_ID} .aj-popup-inner {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 6px;
}
#${POPUP_ID} .aj-popup-xyz-inputs {
	display: flex;
	flex-direction: row;
	gap: 4px;
	margin-left: 2px;
}
#${POPUP_ID} .aj-popup-axis-cell {
	display: flex;
	flex-direction: row;
	align-items: stretch;
}
#${POPUP_ID} .aj-popup-axis-bump {
	min-width: 16px;
	width: 16px;
	padding: 0;
	margin: 0;
	border: 1px solid var(--color-border);
	background: var(--color-button);
	color: var(--color-text);
	cursor: pointer;
	font-size: 12px;
	line-height: 1;
	user-select: none;
	border-radius: 0;
}
#${POPUP_ID} .aj-popup-axis-bump:hover {
	background: var(--color-selected);
}
#${POPUP_ID} .aj-popup-axis-input {
	width: 60px;
	text-align: center;
	border-left: none;
	border-right: none;
	border-radius: 0;
}
#${POPUP_ID} .aj-popup-axis-cell.readonly .aj-popup-axis-input {
	width: 92px;
}
#${POPUP_ID} .aj-popup-axis-readonly {
	opacity: 0.6;
	font-style: italic;
}
#${POPUP_ID} .easing-container {
	display: flex;
	flex-direction: row;
	flex-wrap: wrap;
	grid-gap: 2px;
	margin-left: 2px;
}
#${POPUP_ID} .easing-type {
	width: 32px;
	padding: 0;
	margin: 0;
	min-width: unset;
	display: flex;
	align-items: center;
	justify-content: center;
}
#${POPUP_ID} .easing-type:hover {
	background-color: var(--color-selected);
}
#${POPUP_ID} .selected-keyframe-icon {
	filter: invert(49%) sepia(16%) saturate(6320%) hue-rotate(198deg) brightness(101%) contrast(106%);
}
#${POPUP_ID} .easings-disabled {
	margin-left: 16px;
	font-size: 16px;
	color: var(--color-subtle_text);
	text-wrap: balance;
	margin-bottom: 1rem;
	font-style: italic;
}
#${POPUP_ID} .message {
	margin-left: 16px;
	font-size: 16px;
	color: var(--color-subtle_text);
	text-wrap: balance;
	margin-bottom: 1rem;
	font-style: italic;
}
#${POPUP_ID} label {
	background-color: var(--color-elevated);
	padding-left: 8px;
	align-content: center;
}
#${POPUP_ID} .bar-flex-fix {
	display: flex;
	margin-top: 2px;
	min-height: 32px;
}
`

// 親 document 以外 (= anim_ux popout 子窓 等) に popup を mount する場合、 Blockbench.addCSS は
// 親 head 固定で届かないため、 owner document 側にも同 CSS を ensure する。 同 id で再 mount しない
// idempotent 設計 (= showPopup を連発しても <style> は 1 つだけ)。
function ensurePopupCssIn(ownerDoc: Document): void {
	if (ownerDoc === document) return
	if (ownerDoc.getElementById(POPUP_CSS_ID)) return
	try {
		const style = ownerDoc.createElement('style')
		style.id = POPUP_CSS_ID
		style.textContent = POPUP_CSS
		ownerDoc.head.appendChild(style)
	} catch (e) {
		console.warn('[AJ] popup css inject to popout document failed', e)
	}
}

let unmountCallback: (() => Promise<void>) | null = null
let activeKeyframeUuid: string | undefined = undefined
let activePopupNode: HTMLElement | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
// showPopup 連発時の race 防止 token。 await destroyPopup() の最中に別 showPopup が割り込むと、
// 旧 showPopup が後から mount を完成させて新 popup を上書きする可能性 (= reviewer 指摘 B5)。
// 各 showPopup は自分の世代番号を確保し、 await 後に最新世代と一致しなければ mount を skip する。
let popupGeneration = 0

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
	// popup が anim_ux popout 子窓に乗ってる場合は親 window でなく子窓 window の幅で flip 判定する
	const ownerWin = anchor.ownerDocument?.defaultView ?? window
	// 画面右端ではみ出すなら keyframe の左側に flip
	if (left + popupRect.width > ownerWin.innerWidth - 4) {
		left = Math.max(4, rect.left - popupRect.width - padding)
	}
	// 画面下端ではみ出すなら上に flip
	if (top + popupRect.height > ownerWin.innerHeight - 4) {
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

	// 既に同 keyframe を出していて、 popup が「同 document 内に生存」 してるなら作り直さず再利用。
	// popout 状態遷移 (= 子窓 close → 親に戻る) で旧子窓 node が残ったままだと早期 return で skip
	// されて popup が二度と再作成されない事故が起きるので、 isConnected + ownerDocument 一致を check。
	if (
		activeKeyframeUuid === uuid &&
		activePopupNode &&
		activePopupNode.isConnected &&
		activePopupNode.ownerDocument === (kfElement.ownerDocument ?? document)
	) {
		cancelHide()
		return
	}

	// 自分の世代を確保してから別 keyframe の popup を破棄。 await 後に最新世代でなければ skip。
	const myGeneration = ++popupGeneration
	await destroyPopup()
	if (myGeneration !== popupGeneration) return

	// popup mount 先は keyframe 自身の owner document = anim_ux popout 中なら子窓側になる。
	// 子窓に居る keyframe を hover した時に親 document に popup を出すと別 monitor / 別 window に
	// 飛ばされて視認不能になるため、 keyframe と同じ document に乗せる。
	const ownerDoc = kfElement.ownerDocument ?? document
	ensurePopupCssIn(ownerDoc)
	const node = ownerDoc.createElement('div')
	node.id = POPUP_ID
	node.addEventListener('mouseenter', cancelHide)
	node.addEventListener('mouseleave', scheduleHide)
	ownerDoc.body.appendChild(node)
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
	// svelte の bind:value 経路 + oninput callback を起こす。
	// popup が popout 子窓に乗っている場合は parent realm の Event を投げると realm 不一致を踏むので、
	// active 自身の owner realm の Event constructor を使う。
	const ownerWin = active.ownerDocument?.defaultView
	const EventCtor = (ownerWin?.Event as typeof Event | undefined) ?? Event
	active.dispatchEvent(new EventCtor('input', { bubbles: true }))
}

// event の発生元 document を割り出す helper。
// popup が popout 子窓に乗っていると activeElement は子窓 document 側、 親 document.activeElement は
// popup 内 input ではないので、 event.target の owner document を経由して active を取り直す。
function getEventDocument(e: Event): Document {
	const target = e.target as Element | null
	return target?.ownerDocument ?? document
}

function onAxisKeyCapture(e: KeyboardEvent): void {
	if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
	// plain も含めて全部 capture で処理 (= type=text にしたので browser 標準 Arrow は無関係、
	// 全 case で自前 getInterval が必要)
	const active = getEventDocument(e).activeElement as HTMLInputElement | null
	if (!active || !active.matches(`#${POPUP_ID} input[data-axis]`)) return

	e.preventDefault()
	e.stopPropagation()
	e.stopImmediatePropagation()

	const step = getInterval(e)
	applyToActiveInput(active, e.key === 'ArrowUp' ? step : -step)
}

function onAxisWheelCapture(e: WheelEvent): void {
	const active = getEventDocument(e).activeElement as HTMLInputElement | null
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
		// anim_ux 経由で attach すると popout 中の子窓 document にも自動で追従する。
		// 未 install / 旧 version では document.addEventListener にフォールバック (= attachDocListener 内処理)。
		const detachOnMouseOver = attachDocListener('mouseover', onMouseOver, true)
		const detachOnMouseOut = attachDocListener('mouseout', onMouseOut, true)
		const detachOnAxisKey = attachDocListener('keydown', onAxisKeyCapture, true)
		const detachOnAxisWheel = attachDocListener('wheel', onAxisWheelCapture, {
			capture: true,
			passive: false,
		})
		return { cssDeletable, detachOnMouseOver, detachOnMouseOut, detachOnAxisKey, detachOnAxisWheel }
	},

	revert: ({ cssDeletable, detachOnMouseOver, detachOnMouseOut, detachOnAxisKey, detachOnAxisWheel }) => {
		try { detachOnMouseOver() } catch { /* noop */ }
		try { detachOnMouseOut() } catch { /* noop */ }
		try { detachOnAxisKey() } catch { /* noop */ }
		try { detachOnAxisWheel() } catch { /* noop */ }
		cancelHide()
		void destroyPopup()
		cssDeletable.delete()
	},
})
