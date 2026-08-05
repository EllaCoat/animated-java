/**
 * 外部 plugin (= 物理シミュレーション等) が AJ の datapack export に自分の計算結果を載せるための
 * 汎用 pose pipeline hook。 AJ 側には物理固有のロジックを一切持たせず、 registry と dispatch だけを提供する。
 *
 * 契約 :
 * - **hook が 1 つも登録されていないときの AJ の出力は従来と完全に同一** (= 全 dispatch が no-op)
 * - **同期のみ**。 hook が Promise を返しても await しない
 * - **matrix を返さない**。 hook は Blockbench の scene 上の node pose を直接書き換える。
 *   これにより後段の `getFrame` / 差分省略 / `hashAnimations` / datapack compiler の既存経路がそのまま使える
 * - **呼び出し順** :
 *   `onBeginRendering` → (animation ごとに `onBeginAnimation` → frame ごとに `onPose` → `onEndAnimation`)
 *   → `onEndRendering`。 begin / pose 系は登録順、 end 系は逆順
 * - `onPose` が呼ばれるのは `updatePreview` が keyframe pose を scene に確定させた直後
 * - **`onPose` は同じ `frameIndex` で 1 frame につき複数回呼ばれる**。AJ は 1 frame の中で
 *   `updatePreview` を複数回走らせるため (= IK を成立させるための二度呼び / pre-post 判定の side sample と
 *   その巻き戻し / null_object ごとの再評価)。回数は blueprint の構成で変わるので、 **hook 側は回数を数えず
 *   `frameIndex` の変化だけを見て「進める」 か 「同じ状態を再適用する」 かを決めること**。
 *   同じ `frameIndex` に対しては何度呼ばれても結果が変わらない (= 冪等) 実装が要る
 * - `timeSeconds` は `frameTimeSeconds` と一致しないことがある (= pre-post の side sample では
 *   `frameTimeSeconds + 0.001`)。時刻の正本は `frameIndex` であり、 `timeSeconds` は参考値として扱う
 *
 * この module は Blockbench / THREE の global を実行時に参照しない (= 型は `import type` と ambient のみ)。
 */
import type { IRenderedRig } from './rigRenderer'

/** animation 単位のコンテキスト。 */
export interface RenderAnimationContext {
	animation: _Animation
	rig: IRenderedRig
	excludedNodeUuids: ReadonlySet<string>
	/** 指定時刻の keyframe pose を scene へ再評価する。 呼び出し側が閉包として詰める。 */
	evaluateBasePose(timeSeconds: number): void
}

/** frame 単位のコンテキスト (= `RenderAnimationContext` に時刻情報を足したもの)。 */
export interface RenderHookContext extends RenderAnimationContext {
	/** frame ループの整数。 side sample でも変わらない。 */
	frameIndex: number
	/** `frameIndex / 20`。 */
	frameTimeSeconds: number
	/** `updatePreview` の実引数 (= side sample では `frameTimeSeconds + 0.001`)。 */
	timeSeconds: number
}

export interface RenderHooks {
	onBeginRendering?(): void
	onBeginAnimation?(context: RenderAnimationContext): void
	onPose?(context: RenderHookContext): void
	onEndAnimation?(): void
	onEndRendering?(): void
}

/** hook の callback が throw したときの wrapper。 どの plugin のどの段で落ちたかを保持する。 */
export class RenderHookError extends Error {
	readonly hookId: string
	readonly phase: string

	constructor(hookId: string, phase: string, cause: unknown) {
		super(`Render hook '${hookId}' threw during '${phase}'`, { cause })
		this.name = 'RenderHookError'
		this.hookId = hookId
		this.phase = phase
	}
}

interface IRenderHookParticipant {
	id: string
	hooks: RenderHooks
}

/** 登録順 (= `Map` の挿入順) を保つ registry。 */
const REGISTERED_HOOKS = new Map<string, RenderHooks>()

/**
 * 進行中の session の参加者スナップショット。 `undefined` は session が非 active であることを表す。
 * session 中の register / unregister で参加者が変わらないようにするためスナップショットを持つ
 * (= `onBeginAnimation` を受けていない hook が `onPose` を受ける事態を防ぐ)。
 */
let sessionParticipants: IRenderHookParticipant[] | undefined

/** suppression の入れ子カウンタ。 boolean にすると内側の抜けで外側の抑制が解けるため。 */
let suppressionDepth = 0

// --- registry ---------------------------------------------------------------

export function registerRenderHooks(id: string, hooks: RenderHooks) {
	if (!id) {
		throw new Error('Render hook id must be a non-empty string.')
	}
	if (REGISTERED_HOOKS.has(id)) {
		throw new Error(`Render hooks with id '${id}' are already registered.`)
	}
	REGISTERED_HOOKS.set(id, hooks)
}

export function unregisterRenderHooks(id: string) {
	REGISTERED_HOOKS.delete(id)
}

export function hasRenderHooks() {
	return REGISTERED_HOOKS.size > 0
}

// --- session ----------------------------------------------------------------

export function beginRenderingSession() {
	if (sessionParticipants) {
		throw new Error('A render hook session is already active.')
	}
	const participants = Array.from(REGISTERED_HOOKS, ([id, hooks]) => ({ id, hooks }))
	sessionParticipants = participants
	try {
		dispatchSequential(participants, 'onBeginRendering', hooks => hooks.onBeginRendering?.())
	} catch (error) {
		// session を開けないまま active に残すと以降の export が全て塞がるため、 状態を巻き戻してから rethrow する
		sessionParticipants = undefined
		throw error
	}
}

export function endRenderingSession() {
	const participants = sessionParticipants
	if (!participants) return
	try {
		dispatchCleanup(reversed(participants), 'onEndRendering', hooks => hooks.onEndRendering?.())
	} finally {
		sessionParticipants = undefined
	}
}

export function isRenderingSessionActive() {
	return sessionParticipants !== undefined
}

// --- dispatch ---------------------------------------------------------------

export function dispatchBeginAnimation(context: RenderAnimationContext) {
	const participants = getActiveParticipants()
	if (!participants) return
	dispatchSequential(participants, 'onBeginAnimation', hooks => hooks.onBeginAnimation?.(context))
}

export function dispatchPose(context: RenderHookContext) {
	const participants = getActiveParticipants()
	if (!participants) return
	dispatchSequential(participants, 'onPose', hooks => hooks.onPose?.(context))
}

export function dispatchEndAnimation() {
	const participants = getActiveParticipants()
	if (!participants) return
	dispatchCleanup(reversed(participants), 'onEndAnimation', hooks => hooks.onEndAnimation?.())
}

/** 呼び出し側が context の組み立てコストを避けるための事前判定。 */
export function shouldDispatchPose() {
	const participants = getActiveParticipants()
	return participants !== undefined && participants.length > 0
}

// --- suppression ------------------------------------------------------------

/** `fn` の実行中だけ全 dispatch を抑制する。 入れ子で呼んでよい。 */
export function withRenderHooksSuppressed<T>(fn: () => T): T {
	suppressionDepth++
	try {
		return fn()
	} finally {
		suppressionDepth--
	}
}

export function areRenderHooksSuppressed() {
	return suppressionDepth > 0
}

// --- 公開 API ---------------------------------------------------------------

/** 外部 plugin 向けの公開 API。 `version` は互換性確認用。 */
export const RENDER_HOOKS_API = {
	version: 1,
	register: registerRenderHooks,
	unregister: unregisterRenderHooks,
}

/**
 * registry と session / suppression の状態を全消しする。 **テスト専用** (= production から呼ばない)。
 * vitest の各 case を独立した状態から始めるためだけに存在する。
 */
export function resetRenderHooksForTesting() {
	REGISTERED_HOOKS.clear()
	sessionParticipants = undefined
	suppressionDepth = 0
}

// --- internal ---------------------------------------------------------------

/** dispatch 対象の参加者。 session 非 active または suppression 中は `undefined`。 */
function getActiveParticipants(): IRenderHookParticipant[] | undefined {
	if (!sessionParticipants) return undefined
	if (suppressionDepth > 0) return undefined
	return sessionParticipants
}

function reversed(participants: readonly IRenderHookParticipant[]): IRenderHookParticipant[] {
	return participants.slice().reverse()
}

/** begin / pose 系 : 最初の例外で即 rethrow する (= 以降の hook を呼ばない)。 */
function dispatchSequential(
	participants: readonly IRenderHookParticipant[],
	phase: string,
	invoke: (hooks: RenderHooks) => void
) {
	for (const participant of participants) {
		try {
			invoke(participant.hooks)
		} catch (error) {
			throw new RenderHookError(participant.id, phase, error)
		}
	}
}

/**
 * end 系 : 全件を実行してから最初の例外を throw する (= 1 つ目の失敗が残りの cleanup を飛ばさない)。
 * 2 件目以降の例外は `console.warn` に落とす。
 */
function dispatchCleanup(
	participants: readonly IRenderHookParticipant[],
	phase: string,
	invoke: (hooks: RenderHooks) => void
) {
	let firstError: RenderHookError | undefined
	for (const participant of participants) {
		try {
			invoke(participant.hooks)
		} catch (error) {
			const wrapped = new RenderHookError(participant.id, phase, error)
			if (firstError) console.warn(wrapped)
			else firstError = wrapped
		}
	}
	if (firstError) throw firstError
}
