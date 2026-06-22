<script lang="ts" module>
	import { onMount } from 'svelte'
	import KeyframeEasings from './keyframeEasings.svelte'

	function readAxis(kf: _Keyframe, axis: 'x' | 'y' | 'z'): { value: number | null; raw: string } {
		const raw = String(kf.get(axis) ?? '')
		const num = Number(raw)
		return { value: Number.isFinite(num) ? num : null, raw }
	}

	function roundFixed(n: number, digits = 4): number {
		const f = Math.pow(10, digits)
		return Math.round(n * f) / f
	}

	// BB NumSlider 完全踏襲 (= js/interface/actions.ts:1088-1098)
	export function getInterval(e: { shiftKey?: boolean; ctrlKey?: boolean }): number {
		if (e.ctrlKey && e.shiftKey) return 0.025
		if (e.ctrlKey) return 0.1
		if (e.shiftKey) return 0.25
		return 1
	}
</script>

<script lang="ts">
	interface Props {
		selectedKeyframe: _Keyframe
	}

	let { selectedKeyframe }: Props = $props()

	// input を type="text" にしたので state は string で保持 (= 文字列入力中の中間状態を保持)
	let xValue: string = $state('0')
	let yValue: string = $state('0')
	let zValue: string = $state('0')
	let xEditable: boolean = $state(true)
	let yEditable: boolean = $state(true)
	let zEditable: boolean = $state(true)

	// focus 中の 1 session を 1 Undo step に集約
	let editStarted = false

	onMount(() => {
		const x = readAxis(selectedKeyframe, 'x')
		const y = readAxis(selectedKeyframe, 'y')
		const z = readAxis(selectedKeyframe, 'z')
		xValue = x.value !== null ? String(x.value) : x.raw
		yValue = y.value !== null ? String(y.value) : y.raw
		zValue = z.value !== null ? String(z.value) : z.raw
		xEditable = x.value !== null
		yEditable = y.value !== null
		zEditable = z.value !== null
	})

	function ensureEditStart(): void {
		if (editStarted) return
		Undo.initEdit({ keyframes: [selectedKeyframe] })
		editStarted = true
	}

	function applyAxis(axis: 'x' | 'y' | 'z', value: number): void {
		if (!Number.isFinite(value)) return
		ensureEditStart()
		selectedKeyframe.set(axis, value)
		Animator.preview()
	}

	function finishAxis(axis: 'x' | 'y' | 'z'): void {
		if (!editStarted) return
		Undo.finishEdit(`Change keyframe ${axis.toUpperCase()}`)
		editStarted = false
	}

	function readValue(axis: 'x' | 'y' | 'z'): number {
		const raw = axis === 'x' ? xValue : axis === 'y' ? yValue : zValue
		return parseFloat(raw)
	}

	function writeValue(axis: 'x' | 'y' | 'z', value: number): void {
		const str = String(value)
		if (axis === 'x') xValue = str
		else if (axis === 'y') yValue = str
		else zValue = str
	}

	function bumpAxis(
		axis: 'x' | 'y' | 'z',
		direction: 1 | -1,
		e: MouseEvent | KeyboardEvent | WheelEvent
	): void {
		const current = readValue(axis)
		if (!Number.isFinite(current)) return
		const step = getInterval(e)
		const next = roundFixed(current + step * direction)
		writeValue(axis, next)
		applyAxis(axis, next)
	}

	function onAxisTextInput(axis: 'x' | 'y' | 'z'): void {
		const num = readValue(axis)
		if (!Number.isFinite(num)) return
		applyAxis(axis, num)
	}

	function onBumpMouseDown(axis: 'x' | 'y' | 'z', direction: 1 | -1, e: MouseEvent): void {
		e.preventDefault() // button click で input focus を奪わない
		bumpAxis(axis, direction, e)
	}

	function onAxisKeyDown(e: KeyboardEvent, axis: 'x' | 'y' | 'z'): void {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
		e.preventDefault()
		bumpAxis(axis, e.key === 'ArrowUp' ? 1 : -1, e)
	}

	function onAxisWheel(e: WheelEvent, axis: 'x' | 'y' | 'z'): void {
		if (document.activeElement !== e.currentTarget) return
		e.preventDefault()
		bumpAxis(axis, e.deltaY < 0 ? 1 : -1, e)
	}
</script>

<div class="aj-popup-inner">
	<KeyframeEasings {selectedKeyframe} />
	{#if selectedKeyframe?.transform}
		<div class="bar flex aj-popup-xyz">
			<span
				class="aj-popup-xyz-label"
				style="font-weight: unset; width: 100px; text-align: left;"
				title="Keyframe axis values. Plain=±1, Shift=±0.25, Ctrl=±0.1, Ctrl+Shift=±0.025"
			>
				X / Y / Z
			</span>
			<div class="aj-popup-xyz-inputs">
				{#each ['x', 'y', 'z'] as axis (axis)}
					{@const editable =
						axis === 'x' ? xEditable : axis === 'y' ? yEditable : zEditable}
					{@const valueGetter = () =>
						axis === 'x' ? xValue : axis === 'y' ? yValue : zValue}
					<div class="aj-popup-axis-cell" class:readonly={!editable}>
						{#if editable}
							<button
								class="aj-popup-axis-bump"
								title="Decrease {axis.toUpperCase()} (Plain=−1, Shift=−0.25, Ctrl=−0.1, Ctrl+Shift=−0.025)"
								onmousedown={e =>
									onBumpMouseDown(axis as 'x' | 'y' | 'z', -1, e)}
							>−</button>
							<input
								class="dark_bordered tab_target aj-popup-axis-input"
								type="text"
								inputmode="decimal"
								aria-label="{axis.toUpperCase()} axis value"
								data-axis={axis}
								value={valueGetter()}
								oninput={e => {
									const v = (e.target as HTMLInputElement).value
									if (axis === 'x') xValue = v
									else if (axis === 'y') yValue = v
									else zValue = v
									onAxisTextInput(axis as 'x' | 'y' | 'z')
								}}
								onblur={() => finishAxis(axis as 'x' | 'y' | 'z')}
								onkeydown={e => onAxisKeyDown(e, axis as 'x' | 'y' | 'z')}
								onwheel={e => onAxisWheel(e, axis as 'x' | 'y' | 'z')}
							/>
							<button
								class="aj-popup-axis-bump"
								title="Increase {axis.toUpperCase()} (Plain=+1, Shift=+0.25, Ctrl=+0.1, Ctrl+Shift=+0.025)"
								onmousedown={e =>
									onBumpMouseDown(axis as 'x' | 'y' | 'z', 1, e)}
							>+</button>
						{:else}
							<input
								class="dark_bordered tab_target aj-popup-axis-input aj-popup-axis-readonly"
								type="text"
								readonly
								aria-label="{axis.toUpperCase()} axis molang expression"
								value={valueGetter()}
								title="molang expression (read-only)"
							/>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.aj-popup-inner {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
	}
	.aj-popup-xyz-inputs {
		display: flex;
		flex-direction: row;
		gap: 4px;
		margin-left: 2px;
	}
	.aj-popup-axis-cell {
		display: flex;
		flex-direction: row;
		align-items: stretch;
	}
	.aj-popup-axis-bump {
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
	.aj-popup-axis-bump:hover {
		background: var(--color-selected);
	}
	.aj-popup-axis-input {
		width: 60px;
		text-align: center;
		border-left: none;
		border-right: none;
		border-radius: 0;
	}
	.aj-popup-axis-cell.readonly .aj-popup-axis-input {
		width: 92px; /* +/- button 分の幅も使う */
	}
	.aj-popup-axis-readonly {
		opacity: 0.6;
		font-style: italic;
	}
</style>
