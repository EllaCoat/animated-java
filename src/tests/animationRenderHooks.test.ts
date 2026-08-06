/**
 * animationRenderHooks の registry / session / dispatch / suppression 単体テスト。
 * 対象 module は Blockbench global を実行時に参照しないため、 BB 無しで走る。
 *
 * 確認するのは :
 * 1. registry の登録 / 解除と入力バリデーション
 * 2. session の呼び出し順 (= begin / pose は登録順、 end は逆順) と参加者スナップショット
 * 3. hook 未登録 / session 外 / suppression 中の dispatch が完全 no-op であること
 * 4. hook が throw したときの `RenderHookError` 包装と、 end 系の全件実行
 * 5. 公開 API の `version` (= context に必須フィールドを足したら上げる契約)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	RENDER_HOOKS_API,
	RenderHookError,
	areRenderHooksSuppressed,
	beginRenderingSession,
	dispatchBeginAnimation,
	dispatchEndAnimation,
	dispatchPose,
	endRenderingSession,
	hasRenderHooks,
	isRenderingSessionActive,
	registerRenderHooks,
	resetRenderHooksForTesting,
	shouldDispatchPose,
	unregisterRenderHooks,
	withRenderHooksSuppressed,
	type RenderAnimationContext,
	type RenderHookContext,
} from '../systems/animationRenderHooks'

// --- helpers ----------------------------------------------------------------

/** hook 側は context の中身を見ないので、 型を満たす最小の dummy を使う。 */
function makeAnimationContext(): RenderAnimationContext {
	return {
		animation: {} as _Animation,
		rig: {} as RenderAnimationContext['rig'],
		excludedNodeUuids: new Set<string>(),
		evaluateBasePose: () => {},
		animationLengthSeconds: 0.5,
		renderSampleCount: 11,
		loopMode: 'once',
		loopDelayFrames: 0,
	}
}

function makePoseContext(frameIndex = 0): RenderHookContext {
	return {
		...makeAnimationContext(),
		frameIndex,
		frameTimeSeconds: frameIndex / 20,
		timeSeconds: frameIndex / 20,
	}
}

/** 呼び出し順を 1 本の配列に記録する probe を作る。 */
function makeProbe(id: string, log: string[]) {
	return {
		onBeginRendering: () => log.push(`${id}:beginRendering`),
		onBeginAnimation: () => log.push(`${id}:beginAnimation`),
		onPose: () => log.push(`${id}:pose`),
		onEndAnimation: () => log.push(`${id}:endAnimation`),
		onEndRendering: () => log.push(`${id}:endRendering`),
	}
}

beforeEach(() => {
	resetRenderHooksForTesting()
})

// --- registry ---------------------------------------------------------------

describe('animationRenderHooks - registry', () => {
	it('登録 / 解除に応じて hasRenderHooks が変化する', () => {
		expect(hasRenderHooks()).toBe(false)
		registerRenderHooks('a', {})
		expect(hasRenderHooks()).toBe(true)
		unregisterRenderHooks('a')
		expect(hasRenderHooks()).toBe(false)
	})

	it('空 id の登録は throw する', () => {
		expect(() => registerRenderHooks('', {})).toThrow()
		expect(hasRenderHooks()).toBe(false)
	})

	it('重複 id の登録は throw し、 最初の hooks を保持する (= 上書きしない)', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('first', log))

		expect(() => registerRenderHooks('a', makeProbe('second', log))).toThrow()

		// throw 後も registry には最初の hooks が残っている (= 解除 / 再登録を挟まずに確認する)。
		beginRenderingSession()
		dispatchBeginAnimation(makeAnimationContext())
		dispatchPose(makePoseContext())
		dispatchEndAnimation()
		endRenderingSession()

		expect(log).toEqual([
			'first:beginRendering',
			'first:beginAnimation',
			'first:pose',
			'first:endAnimation',
			'first:endRendering',
		])
		expect(log.some(entry => entry.startsWith('second:'))).toBe(false)
	})

	it('未登録 id の解除は throw しない (= 冪等)', () => {
		expect(() => unregisterRenderHooks('missing')).not.toThrow()
		expect(() => unregisterRenderHooks('missing')).not.toThrow()
	})
})

// --- 公開 API ---------------------------------------------------------------

describe('animationRenderHooks - 公開 API', () => {
	it('version は 2 (= context の周期情報を必須で足した版)', () => {
		expect(RENDER_HOOKS_API.version).toBe(2)
	})

	it('register / unregister は registry 関数そのもの', () => {
		expect(RENDER_HOOKS_API.register).toBe(registerRenderHooks)
		expect(RENDER_HOOKS_API.unregister).toBe(unregisterRenderHooks)
	})
})

// --- session / dispatch -----------------------------------------------------

describe('animationRenderHooks - session と dispatch', () => {
	it('1 hook で begin → animation → pose → endAnimation → endRendering の順に呼ばれる', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('a', log))

		beginRenderingSession()
		dispatchBeginAnimation(makeAnimationContext())
		dispatchPose(makePoseContext(0))
		dispatchPose(makePoseContext(1))
		dispatchEndAnimation()
		endRenderingSession()

		expect(log).toEqual([
			'a:beginRendering',
			'a:beginAnimation',
			'a:pose',
			'a:pose',
			'a:endAnimation',
			'a:endRendering',
		])
	})

	it('複数 hook で begin / pose は登録順、 end は逆順になる', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('a', log))
		registerRenderHooks('b', makeProbe('b', log))

		beginRenderingSession()
		dispatchBeginAnimation(makeAnimationContext())
		dispatchPose(makePoseContext())
		dispatchEndAnimation()
		endRenderingSession()

		expect(log).toEqual([
			'a:beginRendering',
			'b:beginRendering',
			'a:beginAnimation',
			'b:beginAnimation',
			'a:pose',
			'b:pose',
			'b:endAnimation',
			'a:endAnimation',
			'b:endRendering',
			'a:endRendering',
		])
	})

	it('onPose だけを持つ hook でも他の callback 欠落で throw しない', () => {
		const log: string[] = []
		registerRenderHooks('a', { onPose: () => log.push('pose') })

		beginRenderingSession()
		dispatchBeginAnimation(makeAnimationContext())
		dispatchPose(makePoseContext())
		dispatchEndAnimation()
		endRenderingSession()

		expect(log).toEqual(['pose'])
	})

	it('hook が 1 つも無ければ全 dispatch が no-op', () => {
		expect(() => {
			beginRenderingSession()
			dispatchBeginAnimation(makeAnimationContext())
			dispatchPose(makePoseContext())
			dispatchEndAnimation()
			endRenderingSession()
		}).not.toThrow()
		expect(shouldDispatchPose()).toBe(false)
	})

	it('session 外の dispatch は no-op', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('a', log))

		expect(isRenderingSessionActive()).toBe(false)
		expect(shouldDispatchPose()).toBe(false)
		dispatchBeginAnimation(makeAnimationContext())
		dispatchPose(makePoseContext())
		dispatchEndAnimation()
		expect(log).toEqual([])
	})

	it('session 中の register はその session に参加しない (= スナップショット)', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('a', log))

		beginRenderingSession()
		registerRenderHooks('late', makeProbe('late', log))
		dispatchBeginAnimation(makeAnimationContext())
		dispatchPose(makePoseContext())
		dispatchEndAnimation()
		endRenderingSession()

		expect(log.some(entry => entry.startsWith('late:'))).toBe(false)
		expect(hasRenderHooks()).toBe(true)
	})

	it('session 中の unregister でも参加者から外れない (= スナップショット)', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('a', log))

		beginRenderingSession()
		unregisterRenderHooks('a')
		dispatchPose(makePoseContext())
		endRenderingSession()

		expect(log).toEqual(['a:beginRendering', 'a:pose', 'a:endRendering'])
		expect(hasRenderHooks()).toBe(false)
	})

	it('beginRenderingSession の二重呼び出しは throw、 endRenderingSession の二重呼び出しは throw しない', () => {
		beginRenderingSession()
		expect(isRenderingSessionActive()).toBe(true)
		expect(() => beginRenderingSession()).toThrow()

		endRenderingSession()
		expect(isRenderingSessionActive()).toBe(false)
		expect(() => endRenderingSession()).not.toThrow()
	})

	it('shouldDispatchPose は session active かつ hook 登録済みのときだけ true', () => {
		registerRenderHooks('a', makeProbe('a', []))
		expect(shouldDispatchPose()).toBe(false)
		beginRenderingSession()
		expect(shouldDispatchPose()).toBe(true)
		endRenderingSession()
		expect(shouldDispatchPose()).toBe(false)
	})
})

// --- suppression ------------------------------------------------------------

describe('animationRenderHooks - suppression', () => {
	it('suppression 中は dispatch が呼ばれない', () => {
		const log: string[] = []
		registerRenderHooks('a', makeProbe('a', log))
		beginRenderingSession()

		withRenderHooksSuppressed(() => {
			expect(areRenderHooksSuppressed()).toBe(true)
			expect(shouldDispatchPose()).toBe(false)
			dispatchBeginAnimation(makeAnimationContext())
			dispatchPose(makePoseContext())
			dispatchEndAnimation()
		})

		expect(areRenderHooksSuppressed()).toBe(false)
		dispatchPose(makePoseContext())
		endRenderingSession()
		expect(log).toEqual(['a:beginRendering', 'a:pose', 'a:endRendering'])
	})

	it('fn の戻り値をそのまま返す', () => {
		expect(withRenderHooksSuppressed(() => 42)).toBe(42)
	})

	it('fn が throw してもカウンタが戻る', () => {
		expect(() =>
			withRenderHooksSuppressed(() => {
				throw new Error('boom')
			})
		).toThrow('boom')
		expect(areRenderHooksSuppressed()).toBe(false)
	})

	it('入れ子の内側を抜けても外側の抑制は続く', () => {
		const log: string[] = []
		registerRenderHooks('a', { onPose: () => log.push('pose') })
		beginRenderingSession()

		withRenderHooksSuppressed(() => {
			withRenderHooksSuppressed(() => {
				expect(areRenderHooksSuppressed()).toBe(true)
			})
			// 内側を抜けた直後でも抑制されたまま
			expect(areRenderHooksSuppressed()).toBe(true)
			dispatchPose(makePoseContext())
		})

		expect(areRenderHooksSuppressed()).toBe(false)
		endRenderingSession()
		expect(log).toEqual([])
	})
})

// --- 例外の扱い -------------------------------------------------------------

describe('animationRenderHooks - 例外の包装', () => {
	it('onPose の例外は hookId / phase / cause を保った RenderHookError になる', () => {
		const cause = new Error('physics exploded')
		registerRenderHooks('spring-bone', {
			onPose: () => {
				throw cause
			},
		})
		beginRenderingSession()

		let caught: unknown
		try {
			dispatchPose(makePoseContext())
		} catch (error) {
			caught = error
		}
		endRenderingSession()

		expect(caught).toBeInstanceOf(RenderHookError)
		const hookError = caught as RenderHookError
		expect(hookError.hookId).toBe('spring-bone')
		expect(hookError.phase).toBe('onPose')
		expect(hookError.cause).toBe(cause)
		expect(hookError.message).toContain('spring-bone')
		expect(hookError.message).toContain('onPose')
	})

	it('onBeginAnimation の例外は以降の hook を呼ばずに即 rethrow する', () => {
		const log: string[] = []
		registerRenderHooks('a', {
			onBeginAnimation: () => {
				log.push('a')
				throw new Error('boom')
			},
		})
		registerRenderHooks('b', { onBeginAnimation: () => log.push('b') })
		beginRenderingSession()

		expect(() => dispatchBeginAnimation(makeAnimationContext())).toThrow(RenderHookError)
		expect(log).toEqual(['a'])
		endRenderingSession()
	})

	it('onBeginRendering が throw したら session を active に残さない', () => {
		registerRenderHooks('a', {
			onBeginRendering: () => {
				throw new Error('boom')
			},
		})

		expect(() => beginRenderingSession()).toThrow(RenderHookError)
		expect(isRenderingSessionActive()).toBe(false)
	})
})

// --- 部分失敗の unwind ------------------------------------------------------

describe('animationRenderHooks - begin 系の部分失敗 unwind', () => {
	it('onBeginRendering の途中失敗で、 成功済み hook に onEndRendering が届く', () => {
		const log: string[] = []
		registerRenderHooks('a', {
			onBeginRendering: () => log.push('a:begin'),
			onEndRendering: () => log.push('a:end'),
		})
		registerRenderHooks('b', {
			onBeginRendering: () => {
				log.push('b:begin')
				throw new Error('boom')
			},
			onEndRendering: () => log.push('b:end'),
		})

		expect(() => beginRenderingSession()).toThrow(RenderHookError)

		// a は begin を受け取ったので end も受け取る。 b は begin 自体が失敗したので end は来ない。
		expect(log).toEqual(['a:begin', 'b:begin', 'a:end'])
		expect(isRenderingSessionActive()).toBe(false)
	})

	it('onBeginRendering の unwind でも元の例外 (= 失敗した hook 由来) が伝播する', () => {
		const cause = new Error('boom')
		registerRenderHooks('a', { onBeginRendering: () => {} })
		registerRenderHooks('b', {
			onBeginRendering: () => {
				throw cause
			},
		})

		let caught: unknown
		try {
			beginRenderingSession()
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(RenderHookError)
		expect((caught as RenderHookError).hookId).toBe('b')
		expect((caught as RenderHookError).phase).toBe('onBeginRendering')
		expect((caught as RenderHookError).cause).toBe(cause)
	})

	it('unwind 中の onEndRendering が throw しても元の例外が優先される', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const cause = new Error('boom')
		registerRenderHooks('a', {
			onBeginRendering: () => {},
			onEndRendering: () => {
				throw new Error('unwind failed')
			},
		})
		registerRenderHooks('b', {
			onBeginRendering: () => {
				throw cause
			},
		})

		let caught: unknown
		try {
			beginRenderingSession()
		} catch (error) {
			caught = error
		}

		expect((caught as RenderHookError).hookId).toBe('b')
		expect((caught as RenderHookError).cause).toBe(cause)
		// unwind 側の失敗は warn に落ちる
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toBeInstanceOf(RenderHookError)
		expect((warn.mock.calls[0][0] as RenderHookError).phase).toBe('onEndRendering')
		expect(isRenderingSessionActive()).toBe(false)
		warn.mockRestore()
	})

	it('onBeginAnimation の途中失敗で、 成功済み hook に onEndAnimation が届く', () => {
		const log: string[] = []
		registerRenderHooks('a', {
			onBeginAnimation: () => log.push('a:begin'),
			onEndAnimation: () => log.push('a:end'),
		})
		registerRenderHooks('b', {
			onBeginAnimation: () => {
				log.push('b:begin')
				throw new Error('boom')
			},
			onEndAnimation: () => log.push('b:end'),
		})
		beginRenderingSession()

		expect(() => dispatchBeginAnimation(makeAnimationContext())).toThrow(RenderHookError)

		expect(log).toEqual(['a:begin', 'b:begin', 'a:end'])
		endRenderingSession()
	})

	it('onBeginAnimation の unwind でも元の例外が伝播する', () => {
		const cause = new Error('boom')
		registerRenderHooks('a', { onBeginAnimation: () => {} })
		registerRenderHooks('b', {
			onBeginAnimation: () => {
				throw cause
			},
		})
		beginRenderingSession()

		let caught: unknown
		try {
			dispatchBeginAnimation(makeAnimationContext())
		} catch (error) {
			caught = error
		}
		endRenderingSession()

		expect(caught).toBeInstanceOf(RenderHookError)
		expect((caught as RenderHookError).hookId).toBe('b')
		expect((caught as RenderHookError).phase).toBe('onBeginAnimation')
		expect((caught as RenderHookError).cause).toBe(cause)
	})

	it('unwind 中の onEndAnimation が throw しても元の例外が優先される', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const cause = new Error('boom')
		registerRenderHooks('a', {
			onBeginAnimation: () => {},
			onEndAnimation: () => {
				throw new Error('unwind failed')
			},
		})
		registerRenderHooks('b', {
			onBeginAnimation: () => {
				throw cause
			},
		})
		beginRenderingSession()

		let caught: unknown
		try {
			dispatchBeginAnimation(makeAnimationContext())
		} catch (error) {
			caught = error
		}
		endRenderingSession()

		expect((caught as RenderHookError).hookId).toBe('b')
		expect((caught as RenderHookError).cause).toBe(cause)
		expect(warn).toHaveBeenCalledTimes(1)
		expect((warn.mock.calls[0][0] as RenderHookError).phase).toBe('onEndAnimation')
		warn.mockRestore()
	})

	it('onEndAnimation は 1 つ目が throw しても全件実行してから throw する', () => {
		const log: string[] = []
		// end 系は逆順なので b → a の順に走る。 先に走る b を throw させる
		registerRenderHooks('a', { onEndAnimation: () => log.push('a') })
		registerRenderHooks('b', {
			onEndAnimation: () => {
				log.push('b')
				throw new Error('boom')
			},
		})
		beginRenderingSession()

		let caught: unknown
		try {
			dispatchEndAnimation()
		} catch (error) {
			caught = error
		}
		endRenderingSession()

		expect(log).toEqual(['b', 'a'])
		expect(caught).toBeInstanceOf(RenderHookError)
		expect((caught as RenderHookError).hookId).toBe('b')
		expect((caught as RenderHookError).phase).toBe('onEndAnimation')
	})

	it('onEndRendering は全件実行し、 2 件目以降の例外は console.warn に落ちる', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const log: string[] = []
		registerRenderHooks('a', {
			onEndRendering: () => {
				log.push('a')
				throw new Error('boom-a')
			},
		})
		registerRenderHooks('b', {
			onEndRendering: () => {
				log.push('b')
				throw new Error('boom-b')
			},
		})
		beginRenderingSession()

		let caught: unknown
		try {
			endRenderingSession()
		} catch (error) {
			caught = error
		}

		expect(log).toEqual(['b', 'a'])
		expect((caught as RenderHookError).hookId).toBe('b')
		expect(warn).toHaveBeenCalledTimes(1)
		// 例外が出ても session 状態は破棄されている
		expect(isRenderingSessionActive()).toBe(false)
		warn.mockRestore()
	})
})
