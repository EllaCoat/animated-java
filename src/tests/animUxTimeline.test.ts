import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANIM_UX_READY_EVENT, subscribeAnimUxDocuments } from '../util/animUxTimeline'

type ReadyListener = (data: unknown) => void

interface FakeBlockbench {
	on(eventName: string, listener: ReadyListener): void
	removeListener(eventName: string, listener: ReadyListener): void
	emit(eventName: string, data: unknown): void
}

function createBlockbench(): FakeBlockbench {
	const listeners = new Map<string, ReadyListener>()
	return {
		on(eventName, listener) {
			listeners.set(eventName, listener)
		},
		removeListener(eventName, listener) {
			if (listeners.get(eventName) === listener) listeners.delete(eventName)
		},
		emit(eventName, data) {
			listeners.get(eventName)?.(data)
		},
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('subscribeAnimUxDocuments', () => {
	it('uses the parent document until anim-ux becomes ready', () => {
		const parentDocument = {} as Document
		const blockbench = createBlockbench()
		vi.stubGlobal('document', parentDocument)
		vi.stubGlobal('Blockbench', blockbench)
		vi.stubGlobal('AnimUX', undefined)

		const documents: readonly Document[][] = []
		const unsubscribe = subscribeAnimUxDocuments(current => documents.push([...current]))

		const popoutDocument = {} as Document
		const service = {
			subscribeDocuments(listener: (value: readonly Document[]) => void) {
				listener([parentDocument, popoutDocument])
				return vi.fn()
			},
		}
		blockbench.emit(ANIM_UX_READY_EVENT, { api: { timeline: service } })

		expect(documents).toEqual([[parentDocument], [parentDocument, popoutDocument]])
		unsubscribe()
	})

	it('rebinds once when the service changes and cleans up the latest service', () => {
		const parentDocument = {} as Document
		const blockbench = createBlockbench()
		vi.stubGlobal('document', parentDocument)
		vi.stubGlobal('Blockbench', blockbench)

		const firstUnsubscribe = vi.fn()
		const secondUnsubscribe = vi.fn()
		const firstService = {
			subscribeDocuments: vi.fn(() => firstUnsubscribe),
		}
		const secondService = {
			subscribeDocuments: vi.fn(() => secondUnsubscribe),
		}
		const unsubscribe = subscribeAnimUxDocuments(vi.fn())

		blockbench.emit(ANIM_UX_READY_EVENT, { api: { timeline: firstService } })
		blockbench.emit(ANIM_UX_READY_EVENT, { api: { timeline: firstService } })
		blockbench.emit(ANIM_UX_READY_EVENT, { api: { timeline: secondService } })
		unsubscribe()

		expect(firstService.subscribeDocuments).toHaveBeenCalledOnce()
		expect(firstUnsubscribe).toHaveBeenCalledOnce()
		expect(secondService.subscribeDocuments).toHaveBeenCalledOnce()
		expect(secondUnsubscribe).toHaveBeenCalledOnce()
	})
})
