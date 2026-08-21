// keyframe 背景に AJ easing curve を薄く重ね、 keyframe 本体を In/Out/InOut で着色。
//
// mcbCompressionPlugin が build graph の順序に依存して落ちる問題を踏まないよう、
// SVG glob import / CSS file import 等の追加 edge を全廃。 SVG path data + CSS は文字列リテラルで持つ。
// top-level evaluation は const/型定義のみで、 関数呼出は全部 apply() 内に閉じる。

import { registerPatch } from 'blockbench-patch-manager'
import { activeProjectIsBlueprintFormat } from '../formats/blueprint'
import EVENTS from '../util/events'
import { subscribeAnimUxDocuments } from '../util/animUxTimeline'

type EasingDir = 'in' | 'out' | 'inout'

// AJ 既存 src/assets/easingIcons/*.svg からハードコード (= glob import 廃止)
const EASING_PATHS: Record<string, string> = {
	sine: 'M2 22.0001C7 22.0001 18 8.99999 22 2',
	quad: 'M2 22.0001C12 22.0001 18 8.99999 22 2',
	cubic: 'M2 22.0001C12 22.0001 18 12 22 2',
	quart: 'M2 22.0001C14 22.0001 18 12 22 2',
	quint: 'M2 22.0001C15 22.0001 18 15 22 2',
	expo: 'M2 22.0001C18 22.0001 22 18 22 2',
	circ: 'M2 22.0001C22 19.0001 22 12 22 2',
	back: 'M2 20C14 20 18 31 22 2',
	elastic:
		'M2 18.9999C5 18.9999 5 17.9999 7 17.9999C9 17.9999 10 19.9999 12 19.9999C14 19.9999 15.8152 13.0507 17 16.9999C20 26.9999 22 22 22 2',
	bounce: 'M2 22C3 21 4 21 5 22C7 20 7 20 9 22C12 14 15 14 18 22C19 5.99998 22 2 22 2',
}

// CSS は inline string (= 別 css ファイル化を避けて build graph に asset edge を増やさない)
const BASE_CSS = `
.keyframe[data-aj-ease-dir='in']    { --aj-ease-color: #009e73; }
.keyframe[data-aj-ease-dir='out']   { --aj-ease-color: #e69f00; }
.keyframe[data-aj-ease-dir='inout'] { --aj-ease-color: #cc79a7; }

/* font icon / inline SVG / mask-image のどれでも色が当たるよう広く適用 */
.keyframe[data-aj-ease-dir],
.keyframe[data-aj-ease-dir] > i,
.keyframe[data-aj-ease-dir] > svg,
.keyframe[data-aj-ease-dir] [class*='icon-keyframe'] {
	color: var(--aj-ease-color);
}

/* BB 標準 .keyframe は position: absolute、 万一 static 化に備えて fallback */
.keyframe[data-aj-ease-type] {
	position: absolute;
}

.keyframe[data-aj-ease-type]::after {
	content: '';
	position: absolute;
	inset: -50%;
	z-index: -1;
	pointer-events: none;
	opacity: 0.75;
	background-image: var(--aj-ease-curve);
	background-size: contain;
	background-repeat: no-repeat;
	background-position: center;
}
`

function svgDataUrl(pathData: string): string {
	// stroke-width 1.5 = AJ 既存 UI thumbnail (= stroke-width default 1) より太く、 keyframe 背景で視認性確保
	const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${pathData}" stroke="white" stroke-linecap="round" stroke-width="1.5" fill="none"/></svg>`
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function buildCurveCss(): string {
	const rules: string[] = []
	for (const [name, pathData] of Object.entries(EASING_PATHS)) {
		const url = svgDataUrl(pathData)
		rules.push(`.keyframe[data-aj-ease-type="${name}"] { --aj-ease-curve: url("${url}"); }`)
	}
	return rules.join('\n')
}

function parseEasing(easing: string | undefined): { type: string; dir: EasingDir } | null {
	if (!easing || easing === 'linear') return null
	const m = /^ease(InOut|Out|In)(.+)$/.exec(easing)
	if (!m) return null
	return { type: m[2].toLowerCase(), dir: m[1].toLowerCase() as EasingDir }
}

// popout 中は keyframe DOM が子窓側へ adoptNode 移植されるため、親 document の
// querySelector では見つからない。現在の document stream を順に探して要素へ attribute を当てる。
let activeDocuments: readonly Document[] = []

function findKeyframeElement(uuid: string): HTMLElement | null {
	for (const doc of activeDocuments) {
		const el = doc.querySelector<HTMLElement>(`.keyframe[id="${uuid}"]`)
		if (el) return el
	}
	return null
}

function applyDataset(kf: _Keyframe): void {
	const el = findKeyframeElement(kf.uuid)
	if (!el) return
	const parsed = parseEasing(kf.easing)
	if (parsed && parsed.type in EASING_PATHS) {
		el.dataset.ajEaseType = parsed.type
		el.dataset.ajEaseDir = parsed.dir
	} else {
		delete el.dataset.ajEaseType
		delete el.dataset.ajEaseDir
	}
}

function refreshAllKeyframes(): void {
	if (!activeProjectIsBlueprintFormat()) return
	const anim = Animation.selected
	if (!anim) return
	for (const animator of Object.values(anim.animators ?? {})) {
		for (const channel of ['rotation', 'position', 'scale'] as const) {
			const kfList = (animator as unknown as Record<string, _Keyframe[] | undefined>)[channel]
			if (!Array.isArray(kfList)) continue
			for (const kf of kfList) applyDataset(kf)
		}
	}
}

function findKeyframeByUuid(uuid: string): _Keyframe | undefined {
	const anim = Animation.selected
	if (!anim) return undefined
	for (const animator of Object.values(anim.animators ?? {})) {
		for (const channel of ['rotation', 'position', 'scale'] as const) {
			const kfList = (animator as unknown as Record<string, _Keyframe[] | undefined>)[channel]
			if (!Array.isArray(kfList)) continue
			for (const kf of kfList) if (kf.uuid === uuid) return kf
		}
	}
	return undefined
}

// MutationObserver の addedNodes に直接 .keyframe が来るとは限らず、 BB が channel 親要素ごと
// 再描画した場合は親 element が addedNodes に入る (= reviewer 指摘 B3)。 加えて easing 変更時は
// UPDATE_KEYFRAME_SELECTION が発火しないため event 経路では visual 更新されない (= reviewer 指摘 B6)。
// addedNode 自身 + 子孫の .keyframe を再帰探索して個別 applyDataset で attribute 再付与する。
function syncSubtreeKeyframes(root: Node): void {
	if (root.nodeType !== 1) return
	if (root.classList?.contains('keyframe') && root.id) {
		const kf = findKeyframeByUuid(root.id)
		if (kf) applyDataset(kf)
	}
	root.querySelectorAll?.<HTMLElement>('.keyframe').forEach(child => {
		if (!child.id) return
		const kf = findKeyframeByUuid(child.id)
		if (kf) applyDataset(kf)
	})
}

interface DocumentAttach {
	doc: Document
	baseStyle?: HTMLStyleElement
	curveStyle?: HTMLStyleElement
	observer: MutationObserver
}

let documentAttaches: DocumentAttach[] = []

function detachDocuments(): void {
	for (const attachment of documentAttaches) {
		attachment.observer.disconnect()
		attachment.baseStyle?.remove()
		attachment.curveStyle?.remove()
	}
	documentAttaches = []
	activeDocuments = []
}

function attachDocuments(documents: readonly Document[]): void {
	detachDocuments()
	for (const doc of new Set(documents)) {
		if (!doc.body || !doc.head) continue
		let baseStyle: HTMLStyleElement | undefined
		let curveStyle: HTMLStyleElement | undefined
		if (doc !== document) {
			baseStyle = doc.createElement('style')
			baseStyle.textContent = BASE_CSS
			doc.head.appendChild(baseStyle)
			curveStyle = doc.createElement('style')
			curveStyle.textContent = buildCurveCss()
			doc.head.appendChild(curveStyle)
		}
		const observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) syncSubtreeKeyframes(node)
			}
		})
		observer.observe(doc.body, { childList: true, subtree: true })
		documentAttaches.push({ doc, baseStyle, curveStyle, observer })
	}
	activeDocuments = documentAttaches.map(attachment => attachment.doc)
	refreshAllKeyframes()
}

registerPatch({
	id: 'animated_java:keyframe-easing-visual',

	apply: () => {
		const baseCssDeletable = Blockbench.addCSS(BASE_CSS)
		const curveCssDeletable = Blockbench.addCSS(buildCurveCss())

		// 選択変更系のみ。 UPDATE_VIEW / UNDO / REDO は Animate 画面切替等で頻繁発火、 freeze 容疑があるため除外
		const unsubKeyframeSelection = EVENTS.UPDATE_KEYFRAME_SELECTION.subscribe(
			refreshAllKeyframes
		)
		const unsubProjectSelect = EVENTS.SELECT_AJ_PROJECT.subscribe(refreshAllKeyframes)

		const unsubscribeAnimUxDocuments = subscribeAnimUxDocuments(attachDocuments)

		return {
			baseCssDeletable,
			curveCssDeletable,
			unsubKeyframeSelection,
			unsubProjectSelect,
			unsubscribeAnimUxDocuments,
		}
	},

	revert: ({
		baseCssDeletable,
		curveCssDeletable,
		unsubKeyframeSelection,
		unsubProjectSelect,
		unsubscribeAnimUxDocuments,
	}) => {
		const documents = activeDocuments
		unsubscribeAnimUxDocuments()
		detachDocuments()
		unsubKeyframeSelection()
		unsubProjectSelect()
		baseCssDeletable.delete()
		curveCssDeletable.delete()
		for (const doc of documents) {
			doc.querySelectorAll<HTMLElement>('.keyframe[data-aj-ease-type], .keyframe[data-aj-ease-dir]').forEach(
			el => {
				delete el.dataset.ajEaseType
				delete el.dataset.ajEaseDir
			}
		)
		}
	},
})
