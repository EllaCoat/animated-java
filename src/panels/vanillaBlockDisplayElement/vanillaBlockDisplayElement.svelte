<script lang="ts" module>
	import { onDestroy } from 'svelte'
	import { VanillaBlockDisplay } from '../../outliner/vanillaBlockDisplay'
	import EVENTS from '../../util/events'
	import { localize as translate } from '../../util/lang'
	import { validateBlock } from '../../util/minecraftUtil'
</script>

<script lang="ts">
	let selected = $state(VanillaBlockDisplay.selected.at(0))
	let block = $derived(selected?.block)
	let error = $derived(selected?.error)

	const onSelectionChanged = () => {
		selected = VanillaBlockDisplay.selected.at(0)
		block = selected?.block
		error = selected?.error
	}

	const unsubs = [
		EVENTS.UNDO.subscribe(onSelectionChanged),
		EVENTS.REDO.subscribe(onSelectionChanged),
		EVENTS.UPDATE_SELECTION.subscribe(onSelectionChanged),
	]

	$effect(() => {
		const thisSelected = selected
		const thisBlock = block
		// validation は非同期なので、 完了順が入力順と一致する保証がない。
		// capture 時点の selection / 入力が現在値と一致しない結果は、 古い結果として破棄する。
		const isStale = () => selected !== thisSelected || block !== thisBlock
		error?.set('')
		if (thisSelected && thisBlock && thisSelected.block !== thisBlock) {
			void validateBlock(thisBlock)
				.then(err => {
					if (isStale()) return
					if (err) {
						error?.set(err)
						console.log('Block validation error:', err)
						return
					}
					console.log('Changing block to', thisBlock)
					Undo.initEdit({ elements: [thisSelected] })

					thisSelected.block = thisBlock
					Project!.saved = false

					Undo.finishEdit(`Change Block Display Block to "${thisBlock}"`, {
						elements: [thisSelected],
					})
				})
				.catch(err => {
					if (isStale()) return
					error?.set(err.message)
				})
		}
	})

	onDestroy(() => {
		unsubs.forEach(u => u())
	})
</script>

{#if selected}
	<p class="panel_toolbar_label label">
		{translate('panel.vanilla_block_display.title')}
	</p>

	<div
		class="toolbar custom-toolbar"
		title={translate('panel.vanilla_block_display.description')}
	>
		<div class="content" style="width: 95%;">
			<input type="text" bind:value={block} />
		</div>
	</div>

	{#if $error}
		<div class="error">
			{$error}
		</div>
	{/if}
{/if}

<style>
	input {
		background-color: var(--color-button);
		padding: 2px 8px;
		width: 100%;
	}
	.label {
		margin-bottom: -3px !important;
	}
	.custom-toolbar {
		display: flex;
		flex-direction: row;
		margin-bottom: 1px;
	}
	.custom-toolbar :global(.sp-replacer) {
		padding: 4px 18px !important;
		height: 28px !important;
		margin: 1px 0px !important;
	}
	.error {
		margin: 2px 8px;
		font-size: 14px;
		color: var(--color-error);
	}
</style>
