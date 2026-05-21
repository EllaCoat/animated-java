<script lang="ts">
	import { onDestroy } from 'svelte'
	import Checkbox from '../../../svelteComponents/sidebarDialogItems/checkbox.svelte'
	import NumberSlider from '../../../svelteComponents/sidebarDialogItems/numberSlider.svelte'

	let tsbOptimizedExport = $state(Project.animated_java.tsb_optimized_export)
	let tsbQuantizationDigits = $state(Project.animated_java.tsb_quantization_digits_default)
	let tsbCellsPerTick = $state(Project.animated_java.tsb_cells_per_tick)
	let tsbMaxLineBytes = $state(Project.animated_java.tsb_max_line_bytes)

	onDestroy(() => {
		Project.animated_java.tsb_optimized_export = tsbOptimizedExport
		Project.animated_java.tsb_quantization_digits_default = tsbQuantizationDigits
		Project.animated_java.tsb_cells_per_tick = tsbCellsPerTick
		Project.animated_java.tsb_max_line_bytes = tsbMaxLineBytes
	})
</script>

<div class="dialog-page-container">
	<Checkbox
		label="TSB Optimized Export"
		description="Enable the TSB-specific datapack output (B structure, macro-row staged loading, base36 IDs, quantized floats). Only supported on Minecraft 1.20.4. Disable for the standard Animated Java output."
		bind:value={tsbOptimizedExport}
	></Checkbox>

	{#if tsbOptimizedExport}
		<NumberSlider
			label="Quantization Digits (default)"
			description="Default number of decimal digits used when quantizing float literals in animation NBT. Range 2..7. Can be overridden per animation."
			step={1}
			bind:value={tsbQuantizationDigits}
			min={2}
			max={7}
		></NumberSlider>

		<NumberSlider
			label="Cells per Tick"
			description="Maximum number of animation cells (bone x frame x 10 floats) to expand per tick during staged loading. Higher values shorten total load time but increase per-tick load. Range 100..50000."
			step={100}
			bind:value={tsbCellsPerTick}
			min={100}
			max={50000}
		></NumberSlider>

		<NumberSlider
			label="Max Line Bytes (sanity check)"
			description="Sanity check threshold for a single macro line (1 bone set value). Generation fails with an error if a bone's set value exceeds this size, so the user can shorten the animation or lower the quantization. Default 1,000,000 bytes (matches stock AJ split threshold)."
			step={100000}
			bind:value={tsbMaxLineBytes}
			min={100000}
			max={100000000}
		></NumberSlider>
	{/if}
</div>

<style>
	.dialog-page-container {
		overflow-y: auto;
		max-height: 75vh;
		padding-right: 16px;
		padding-left: 2px;
	}
</style>
