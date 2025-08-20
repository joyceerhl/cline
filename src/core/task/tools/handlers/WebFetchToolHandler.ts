import { showSystemNotification } from "@integrations/notifications"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { telemetryService } from "@services/posthog/PostHogClientProvider"
import { ClineAsk, ClineSayTool } from "@shared/ExtensionMessage"
import { ToolUse, ToolUseName } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import { showNotificationForApprovalIfAutoApprovalEnabled } from "../../utils"
import type { IPartialBlockHandler, IToolHandler, UIHelpers } from "../ToolExecutorCoordinator"

export class WebFetchToolHandler implements IToolHandler, IPartialBlockHandler {
	name = "web_fetch"
	supportedTools: ToolUseName[] = ["web_fetch"]

	async execute(config: any, block: ToolUse): Promise<ToolResponse> {
		// For partial blocks, don't execute yet
		if (block.partial) {
			return ""
		}

		try {
			const url: string | undefined = block.params.url

			// Validate required parameter
			if (!url) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError("web_fetch", "url")
			}
			config.taskState.consecutiveMistakeCount = 0

			// Show notification if auto-approval is enabled
			if (config.autoApprovalSettings.enabled && config.autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "Cline wants to fetch web content...",
					message: `Cline is requesting to fetch content from: ${url}`,
				})
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
		} catch (error) {
			return `Error fetching web content: ${(error as Error).message}`
		}
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: UIHelpers): Promise<void> {
		const url = block.params.url || ""
		const sharedMessageProps: ClineSayTool = {
			tool: "webFetch",
			path: uiHelpers.removeClosingTag(block, "url", url),
			content: `Fetching URL: ${uiHelpers.removeClosingTag(block, "url", url)}`,
			operationIsLocatedInWorkspace: false, // web_fetch is always external
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		// For partial blocks, we'll let the ToolExecutionManager handle auto-approval logic
		// Just stream the UI update for now
		await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
		await uiHelpers.ask("tool" as ClineAsk, partialMessage, block.partial).catch(() => {})
	}
}
