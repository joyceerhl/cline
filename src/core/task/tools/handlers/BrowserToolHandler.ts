import { BrowserSession } from "@services/browser/BrowserSession"
import {
	BrowserAction,
	BrowserActionResult,
	browserActions,
	ClineAsk,
	ClineSay,
	ClineSayBrowserAction,
} from "@shared/ExtensionMessage"
import { ClineAskResponse } from "@shared/WebviewMessage"
import { modelDoesntSupportWebp } from "@utils/model-utils"
import { ToolUse, ToolUseName } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import type { IToolHandler } from "../ToolExecutorCoordinator"

export class BrowserToolHandler implements IToolHandler {
	name = "browser"
	supportedTools: ToolUseName[] = ["browser_action"]

	async execute(config: any, block: ToolUse): Promise<ToolResponse> {
		const action: BrowserAction | undefined = block.params.action as BrowserAction
		const url: string | undefined = block.params.url
		const coordinate: string | undefined = block.params.coordinate
		const text: string | undefined = block.params.text

		// Validate action parameter - following original pattern
		if (!action || !browserActions.includes(action)) {
			// checking for action to ensure it is complete and valid
			if (!block.partial) {
				// if the block is complete and we don't have a valid action this is a mistake
				config.taskState.consecutiveMistakeCount++
				const errorResult = await config.sayAndCreateMissingParamError("browser_action", "action")
				await config.services.browserSession.closeBrowser()
				await config.saveCheckpoint()
				return errorResult
			}
			// For partial blocks, just return empty result and wait for more content
			return []
		}

		try {
			if (block.partial) {
				// Handle partial block streaming
				if (action === "launch") {
					if (config.shouldAutoApproveTool(block.name)) {
						config.removeLastPartialMessageIfExistsWithType("ask", "browser_action_launch")
						await config.say(
							"browser_action_launch",
							config.removeClosingTag(block, "url", url),
							undefined,
							undefined,
							block.partial,
						)
					} else {
						config.removeLastPartialMessageIfExistsWithType("say", "browser_action_launch")
						await config
							.ask("browser_action_launch", config.removeClosingTag(block, "url", url), block.partial)
							.catch(() => {})
					}
				} else {
					await config.say(
						"browser_action",
						JSON.stringify({
							action: action as BrowserAction,
							coordinate: config.removeClosingTag(block, "coordinate", coordinate),
							text: config.removeClosingTag(block, "text", text),
						} satisfies ClineSayBrowserAction),
						undefined,
						undefined,
						block.partial,
					)
				}
				// Return empty result for partial blocks
				return []
			} else {
				// Handle complete block execution
				let browserActionResult: BrowserActionResult

				if (action === "launch") {
					if (!url) {
						config.taskState.consecutiveMistakeCount++
						const errorResult = await config.sayAndCreateMissingParamError("browser_action", "url")
						await config.services.browserSession.closeBrowser()
						await config.saveCheckpoint()
						return errorResult
					}
					config.taskState.consecutiveMistakeCount = 0

					// Handle approval flow for launch
					if (config.shouldAutoApproveTool(block.name)) {
						config.removeLastPartialMessageIfExistsWithType("ask", "browser_action_launch")
						await config.say("browser_action_launch", url, undefined, undefined, false)
						config.taskState.consecutiveAutoApprovedRequestsCount++
					} else {
						// Show notification for approval if auto approval enabled
						const { showNotificationForApprovalIfAutoApprovalEnabled } = require("../../utils")
						showNotificationForApprovalIfAutoApprovalEnabled(
							`Cline wants to use a browser and launch ${url}`,
							config.autoApprovalSettings.enabled,
							config.autoApprovalSettings.enableNotifications,
						)
						config.removeLastPartialMessageIfExistsWithType("say", "browser_action_launch")
						const didApprove = await config.askApproval("browser_action_launch", block, url)
						if (!didApprove) {
							await config.saveCheckpoint()
							return formatResponse.toolResult("The user rejected this browser action.")
						}
					}

					// Start loading spinner
					await config.say("browser_action_result", "")

					// Re-make browserSession to make sure latest settings apply
					const browserSession = config.services.browserSession
					if (config.context) {
						await browserSession.dispose()
						const apiHandlerModel = config.api.getModel()
						const useWebp = config.api ? !modelDoesntSupportWebp(apiHandlerModel) : true
						config.services.browserSession = new BrowserSession(config.context, config.browserSettings, useWebp)
					} else {
						console.warn("no controller context available for browserSession")
					}
					await config.services.browserSession.launchBrowser()
					browserActionResult = await config.services.browserSession.navigateToUrl(url)
				} else {
					// Handle other actions (click, type, scroll, close)
					if (action === "click") {
						if (!coordinate) {
							config.taskState.consecutiveMistakeCount++
							const errorResult = await config.sayAndCreateMissingParamError("browser_action", "coordinate")
							await config.services.browserSession.closeBrowser()
							await config.saveCheckpoint()
							return errorResult
						}
					}
					if (action === "type") {
						if (!text) {
							config.taskState.consecutiveMistakeCount++
							const errorResult = await config.sayAndCreateMissingParamError("browser_action", "text")
							await config.services.browserSession.closeBrowser()
							await config.saveCheckpoint()
							return errorResult
						}
					}
					config.taskState.consecutiveMistakeCount = 0

					// Send browser action message
					await config.say(
						"browser_action",
						JSON.stringify({
							action: action as BrowserAction,
							coordinate,
							text,
						} satisfies ClineSayBrowserAction),
						undefined,
						undefined,
						false,
					)

					// Execute the action
					const browserSession = config.services.browserSession
					switch (action) {
						case "click":
							browserActionResult = await browserSession.click(coordinate!)
							break
						case "type":
							browserActionResult = await browserSession.type(text!)
							break
						case "scroll_down":
							browserActionResult = await browserSession.scrollDown()
							break
						case "scroll_up":
							browserActionResult = await browserSession.scrollUp()
							break
						case "close":
							browserActionResult = await browserSession.closeBrowser()
							break
					}
				}

				// Handle results based on action type
				switch (action) {
					case "launch":
					case "click":
					case "type":
					case "scroll_down":
					case "scroll_up":
						await config.say("browser_action_result", JSON.stringify(browserActionResult))
						const result = formatResponse.toolResult(
							`The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\nConsole logs:\n${
								browserActionResult.logs || "(No new logs)"
							}\n\n(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, you MUST first close this browser. For example, if after analyzing the logs and screenshot you need to edit a file, you must first close the browser before you can use the write_to_file tool.)`,
							browserActionResult.screenshot ? [browserActionResult.screenshot] : [],
						)

						if (!block.partial) {
							await config.updateFCListFromToolResponse(block.params.task_progress)
						}

						await config.saveCheckpoint()
						return result

					case "close":
						const closeResult = formatResponse.toolResult(
							`The browser has been closed. You may now proceed to using other tools.`,
						)
						await config.saveCheckpoint()
						return closeResult
				}
			}
		} catch (error) {
			await config.services.browserSession.closeBrowser() // if any error occurs, the browser session is terminated
			await config.handleError("executing browser action", error, block)
			await config.saveCheckpoint()
			throw error
		}

		// This should never be reached, but TypeScript requires a return
		return []
	}
}
