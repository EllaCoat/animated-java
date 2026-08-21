export const ANIM_UX_READY_EVENT = 'animux:ready'

export type AnimUxDocumentsListener = (documents: readonly Document[]) => void

interface AnimUxTimelineService {
	subscribeDocuments(listener: AnimUxDocumentsListener): () => void
}

interface AnimUxApi {
	timeline: AnimUxTimelineService
}

interface AnimUxReadyData {
	api?: unknown
}

interface BlockbenchEventHost {
	on(eventName: string, listener: (data: unknown) => void): unknown
	removeListener(eventName: string, listener: (data: unknown) => void): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function asAnimUxApi(value: unknown): AnimUxApi | undefined {
	if (!isRecord(value) || !isRecord(value.timeline)) return undefined
	if (typeof value.timeline.subscribeDocuments !== 'function') return undefined
	return value as unknown as AnimUxApi
}

function getCurrentApi(): AnimUxApi | undefined {
	const value = (globalThis as typeof globalThis & { AnimUX?: unknown }).AnimUX
	return asAnimUxApi(value)
}

function getBlockbench(): BlockbenchEventHost | undefined {
	const value = (globalThis as typeof globalThis & { Blockbench?: unknown }).Blockbench
	if (!isRecord(value)) return undefined
	if (typeof value.on !== 'function' || typeof value.removeListener !== 'function') return undefined
	return value as unknown as BlockbenchEventHost
}

function getReadyApi(data: unknown): AnimUxApi | undefined {
	if (!isRecord(data)) return undefined
	return asAnimUxApi((data as AnimUxReadyData).api)
}

function notifyParentDocument(listener: AnimUxDocumentsListener): void {
	listener([document])
}

/**
 * Tracks the optional anim-ux timeline service and exposes one document stream.
 * The stream always has a usable parent-document fallback when anim-ux is absent.
 */
export function subscribeAnimUxDocuments(listener: AnimUxDocumentsListener): () => void {
	let currentService: AnimUxTimelineService | undefined
	let unsubscribeService: (() => void) | undefined
	let disposed = false
	let hasBoundService = false

	const bindService = (api: AnimUxApi | undefined): void => {
		if (disposed) return
		const nextService = api?.timeline
		if (hasBoundService && nextService === currentService) return

		unsubscribeService?.()
		unsubscribeService = undefined
		currentService = nextService
		hasBoundService = true

		if (!nextService) {
			notifyParentDocument(listener)
			return
		}

		try {
			unsubscribeService = nextService.subscribeDocuments(listener)
		} catch (error) {
			currentService = undefined
			notifyParentDocument(listener)
			console.warn('[AJ] AnimUX timeline subscription failed, using parent document', error)
		}
	}

	const onReady = (data: unknown): void => {
		bindService(getReadyApi(data))
	}

	const blockbench = getBlockbench()
	blockbench?.on(ANIM_UX_READY_EVENT, onReady)
	bindService(getCurrentApi())

	return (): void => {
		if (disposed) return
		disposed = true
		blockbench?.removeListener(ANIM_UX_READY_EVENT, onReady)
		unsubscribeService?.()
		unsubscribeService = undefined
		currentService = undefined
	}
}
