import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { ToolUse, ToolUseName } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import type { IToolHandler } from "../ToolExecutorCoordinator"

export class WebFetchToolHandler implements IToolHandler {
	name = "web_fetch"
	supportedTools: ToolUseName[] = ["web_fetch"]

	async execute(config: any, block: ToolUse): Promise<ToolResponse> {
		const url: string | undefined = block.params.url

		if (!url) {
			throw new Error("URL is required for web_fetch")
		}

		const urlContentFetcher = config.services?.urlContentFetcher as UrlContentFetcher

		await urlContentFetcher.launchBrowser()
		try {
			// Fetch Markdown content
			const markdownContent = await urlContentFetcher.urlToMarkdown(url)

			// TODO: Implement secondary AI call to process markdownContent with prompt
			// For now, returning markdown directly.
			// This will be a significant sub-task.
			// Placeholder for processed summary:
			const processedSummary = `Fetched Markdown for ${url}:\n\n${markdownContent}`

			return formatResponse.toolResult(processedSummary)
		} finally {
			// Ensure browser is closed even on error
			await urlContentFetcher.closeBrowser()
		}
	}
}
