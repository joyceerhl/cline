import { ClineAsk, ClineSay } from "@shared/ExtensionMessage"
import { ClineAskResponse } from "@shared/WebviewMessage"
import * as path from "path"
import { ToolUse, ToolUseName } from "../../assistant-message"
import { formatResponse } from "../../prompts/responses"
import { AccessMcpResourceHandler } from "./handlers/AccessMcpResourceHandler"
import { AskFollowupQuestionToolHandler } from "./handlers/AskFollowupQuestionToolHandler"
import { AttemptCompletionHandler } from "./handlers/AttemptCompletionHandler"
import { BrowserToolHandler } from "./handlers/BrowserToolHandler"
import { CondenseHandler } from "./handlers/CondenseHandler"
import { ExecuteCommandToolHandler } from "./handlers/ExecuteCommandToolHandler"
import { ListCodeDefinitionNamesToolHandler } from "./handlers/ListCodeDefinitionNamesToolHandler"
import { ListFilesToolHandler } from "./handlers/ListFilesToolHandler"
import { LoadMcpDocumentationHandler } from "./handlers/LoadMcpDocumentationHandler"
import { NewTaskHandler } from "./handlers/NewTaskHandler"
import { PlanModeRespondHandler } from "./handlers/PlanModeRespondHandler"
import { ReadFileToolHandler } from "./handlers/ReadFileToolHandler"
import { ReportBugHandler } from "./handlers/ReportBugHandler"
import { SearchFilesToolHandler } from "./handlers/SearchFilesToolHandler"
import { SummarizeTaskHandler } from "./handlers/SummarizeTaskHandler"
import { UseMcpToolHandler } from "./handlers/UseMcpToolHandler"
import { WebFetchToolHandler } from "./handlers/WebFetchToolHandler"
import { WriteToFileToolHandler } from "./handlers/WriteToFileToolHandler"
import type { IPartialBlockHandler, UIHelpers } from "./ToolExecutorCoordinator"
import { ToolExecutorCoordinator } from "./ToolExecutorCoordinator"
import { ToolValidator } from "./ToolValidator"
import { ToolApprovalManager } from "./utils/ToolApprovalManager"
import { ToolDisplayUtils } from "./utils/ToolDisplayUtils"
import { ToolErrorHandler } from "./utils/ToolErrorHandler"
import { ToolExecutionStrategies } from "./utils/ToolExecutionStrategies"
import { ToolMessageUtils } from "./utils/ToolMessageUtils"
import { ToolValidationUtils } from "./utils/ToolValidationUtils"

/**
 * Tools that are restricted in plan mode and can only be used in act mode
 */
const PLAN_MODE_RESTRICTED_TOOLS: ToolUseName[] = ["write_to_file", "replace_in_file", "new_rule"]

/**
 * Manages the execution of tools registered with the coordinator.
 * This class encapsulates all the approval flow, UI updates, telemetry,
 * and orchestration logic, keeping the main ToolExecutor thin and focused.
 */
export class ToolExecutionManager {
	private approvalManager: ToolApprovalManager

	constructor(
		private coordinator: ToolExecutorCoordinator,
		private config: any,
		private pushToolResult: (content: any, block: ToolUse) => void,
		private removeClosingTag: (block: ToolUse, tag: any, text?: string) => string,
		private shouldAutoApproveToolWithPath: (toolName: ToolUseName, path?: string) => Promise<boolean>,
		private sayAndCreateMissingParamError: (toolName: ToolUseName, paramName: string) => Promise<any>,
		private removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: any) => Promise<void>,
		private say: (
			type: ClineSay,
			text?: string,
			images?: string[],
			files?: string[],
			partial?: boolean,
		) => Promise<number | undefined>,
		private ask: (
			type: ClineAsk,
			text?: string,
			partial?: boolean,
		) => Promise<{
			response: ClineAskResponse
			text?: string
			images?: string[]
			files?: string[]
		}>,
		private askApproval: (type: ClineAsk, block: ToolUse, message: string) => Promise<boolean>,
		private saveCheckpoint: () => Promise<void>,
		private updateFCListFromToolResponse: (taskProgress?: string) => Promise<void>,
		private handleError: (action: string, error: Error, block: ToolUse) => Promise<void>,
	) {
		// Initialize the approval manager
		this.approvalManager = new ToolApprovalManager(
			config,
			shouldAutoApproveToolWithPath,
			removeLastPartialMessageIfExistsWithType,
			say,
			ask,
			askApproval,
		)
	}

	/**
	 * Factory method to create a ToolExecutionManager with all tool handlers registered
	 */
	static create(
		config: any,
		pushToolResult: (content: any, block: ToolUse) => void,
		shouldAutoApproveToolWithPath: (toolName: ToolUseName, path?: string) => Promise<boolean>,
		sayAndCreateMissingParamError: (toolName: ToolUseName, paramName: string) => Promise<any>,
		removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: any) => Promise<void>,
		say: (
			type: ClineSay,
			text?: string,
			images?: string[],
			files?: string[],
			partial?: boolean,
		) => Promise<number | undefined>,
		ask: (
			type: ClineAsk,
			text?: string,
			partial?: boolean,
		) => Promise<{
			response: ClineAskResponse
			text?: string
			images?: string[]
			files?: string[]
		}>,
		askApproval: (type: ClineAsk, block: ToolUse, message: string) => Promise<boolean>,
		saveCheckpoint: () => Promise<void>,
		updateFCListFromToolResponse: (taskProgress?: string) => Promise<void>,
		handleError: (action: string, error: Error, block: ToolUse) => Promise<void>,
	): ToolExecutionManager {
		// Create and configure the coordinator
		const coordinator = new ToolExecutorCoordinator()

		// Register tool handlers
		const validator = new ToolValidator(config.services.clineIgnoreController)
		coordinator.register(new ListFilesToolHandler(validator))
		coordinator.register(new ReadFileToolHandler(validator))
		coordinator.register(new BrowserToolHandler())
		coordinator.register(new AskFollowupQuestionToolHandler())
		coordinator.register(new WebFetchToolHandler())

		// Register WriteToFileToolHandler for all three file tools
		const writeHandler = new WriteToFileToolHandler(validator)
		coordinator.register(writeHandler) // registers as "write_to_file"
		coordinator.register({ name: "replace_in_file", execute: writeHandler.execute.bind(writeHandler) })
		coordinator.register({ name: "new_rule", execute: writeHandler.execute.bind(writeHandler) })

		coordinator.register(new ListCodeDefinitionNamesToolHandler(validator))
		coordinator.register(new SearchFilesToolHandler(validator))
		coordinator.register(new ExecuteCommandToolHandler(validator))
		coordinator.register(new UseMcpToolHandler())
		coordinator.register(new AccessMcpResourceHandler())
		coordinator.register(new LoadMcpDocumentationHandler())
		coordinator.register(new PlanModeRespondHandler())
		coordinator.register(new NewTaskHandler())
		coordinator.register(new AttemptCompletionHandler())
		coordinator.register(new CondenseHandler())
		coordinator.register(new SummarizeTaskHandler())
		coordinator.register(new ReportBugHandler())

		// Create and return the execution manager
		return new ToolExecutionManager(
			coordinator,
			config,
			pushToolResult,
			ToolDisplayUtils.removeClosingTag,
			shouldAutoApproveToolWithPath,
			sayAndCreateMissingParamError,
			removeLastPartialMessageIfExistsWithType,
			say,
			ask,
			askApproval,
			saveCheckpoint,
			updateFCListFromToolResponse,
			handleError,
		)
	}

	/**
	 * Execute a tool through the coordinator if it's registered
	 */
	async execute(block: ToolUse): Promise<boolean> {
		if (!this.coordinator.has(block.name)) {
			return false // Tool not handled by coordinator
		}

		try {
			// Check if user rejected a previous tool
			if (this.config.taskState.didRejectTool) {
				// ignore any tool content after user has rejected tool once
				const reason = block.partial
					? "Tool was interrupted and not executed due to user rejecting a previous tool."
					: "Skipping tool due to user rejecting a previous tool."
				this.createToolRejectionMessage(block, reason)
				return true
			}

			// Check if a tool has already been used in this message
			if (this.config.taskState.didAlreadyUseTool) {
				// ignore any content after a tool has already been used
				this.config.taskState.userMessageContent.push({
					type: "text",
					text: formatResponse.toolAlreadyUsed(block.name),
				})
				return true
			}

			// Logic for plan-mode tool call restrictions
			if (
				this.config.strictPlanModeEnabled &&
				this.config.mode === "plan" &&
				block.name &&
				this.isPlanModeToolRestricted(block.name)
			) {
				const errorMessage = `Tool '${block.name}' is not available in PLAN MODE. This tool is restricted to ACT MODE for file modifications. Only use tools available for PLAN MODE when in that mode.`
				await this.say("error", errorMessage)
				this.pushToolResult(formatResponse.toolError(errorMessage), block)
				await this.saveCheckpoint()
				return true
			}

			// Close browser for non-browser tools
			if (block.name !== "browser_action") {
				await this.config.services.browserSession.closeBrowser()
			}

			// Handle partial blocks
			if (block.partial) {
				await this.handlePartialBlock(block)
				return true
			}

			// Handle complete blocks
			await this.handleCompleteBlock(block)
			return true
		} catch (error) {
			await this.handleError(`executing ${block.name}`, error as Error, block)
			await this.saveCheckpoint()
			return true
		}
	}
	/**
	 * Check if a tool is restricted in plan mode
	 */
	private isPlanModeToolRestricted(toolName: ToolUseName): boolean {
		return PLAN_MODE_RESTRICTED_TOOLS.includes(toolName)
	}

	/**
	 * Create a tool rejection message and add it to user message content
	 */
	private createToolRejectionMessage(block: ToolUse, reason: string): void {
		this.config.taskState.userMessageContent.push({
			type: "text",
			text: `${reason} ${ToolDisplayUtils.getToolDescription(block)}`,
		})
	}

	/**
	 * Handle partial block streaming UI updates
	 */
	private async handlePartialBlock(block: ToolUse): Promise<void> {
		const handler = this.coordinator.getHandler(block.name)

		// Check if handler supports partial blocks (hybrid approach)
		if (handler && "handlePartialBlock" in handler) {
			const uiHelpers: UIHelpers = {
				ask: this.ask,
				say: this.say,
				removeClosingTag: this.removeClosingTag,
				removeLastPartialMessageIfExistsWithType: this.removeLastPartialMessageIfExistsWithType,
				shouldAutoApproveTool: (toolName: ToolUseName) => {
					const result = this.config.autoApprover?.shouldAutoApproveTool(toolName)
					return Array.isArray(result) ? result[0] : result || false
				},
				askApproval: async (messageType: string, message: string) => {
					return await this.askApproval(messageType as any, block, message)
				},
				captureTelemetry: (toolName: ToolUseName, autoApproved: boolean, approved: boolean) => {
					const telemetryService = require("@services/posthog/PostHogClientProvider").telemetryService
					telemetryService.captureToolUsage(
						this.config.ulid,
						toolName,
						this.config.api.getModel().id,
						autoApproved,
						approved,
					)
				},
				showNotificationIfEnabled: (message: string) => {
					const { showNotificationForApprovalIfAutoApprovalEnabled } = require("../utils")
					showNotificationForApprovalIfAutoApprovalEnabled(
						message,
						this.config.autoApprovalSettings.enabled,
						this.config.autoApprovalSettings.enableNotifications,
					)
				},
			}

			await (handler as IPartialBlockHandler).handlePartialBlock(block, uiHelpers)
			return
		}

		// Fallback to existing switch statement for tools that haven't been migrated yet
		switch (block.name) {
			case "read_file":
			case "list_files":
			case "list_code_definition_names":
			case "search_files":
				await this.handleFileToolPartialBlock(block)
				break
			case "write_to_file":
			case "replace_in_file":
			case "new_rule":
				await this.handleWriteToolPartialBlock(block)
				break
			case "browser_action":
				// Browser actions handle their own partial blocks in the handler
				return
			case "load_mcp_documentation":
				// load_mcp_documentation doesn't support partial streaming
				return
			default:
				// Other tools don't support partial streaming yet
				return
		}
	}

	/**
	 * Handle partial blocks for file-related tools
	 */
	private async handleFileToolPartialBlock(block: ToolUse): Promise<void> {
		const sharedMessageProps = await ToolMessageUtils.createFileToolMessageProps(
			block,
			this.config.cwd,
			this.removeClosingTag,
		)

		const partialMessage = JSON.stringify(sharedMessageProps)

		if (await this.shouldAutoApproveToolWithPath(block.name, block.params.path)) {
			await this.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await this.say("tool" as ClineSay, partialMessage, undefined, undefined, block.partial)
		} else {
			await this.removeLastPartialMessageIfExistsWithType("say", "tool")
			await this.ask("tool" as ClineAsk, partialMessage, block.partial).catch(() => {})
		}
	}

	/**
	 * Handle partial blocks for write-related tools
	 */
	private async handleWriteToolPartialBlock(block: ToolUse): Promise<void> {
		const relPath = block.params.path
		const content = block.params.content // for write_to_file
		let diff = block.params.diff // for replace_in_file

		// Early return if we don't have enough data yet
		if (!relPath || (!content && !diff)) {
			// Wait until we have the path and either content or diff
			return
		}

		// Check if file exists to determine the correct UI message
		let fileExists: boolean
		if (this.config.services.diffViewProvider.editType !== undefined) {
			fileExists = this.config.services.diffViewProvider.editType === "modify"
		} else {
			const absolutePath = path.resolve(this.config.cwd, relPath)
			fileExists = await require("@utils/fs").fileExistsAtPath(absolutePath)
			this.config.services.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		const sharedMessageProps = await ToolMessageUtils.createWriteToolMessageProps(
			block,
			this.config.cwd,
			fileExists,
			this.removeClosingTag,
		)

		const partialMessage = JSON.stringify(sharedMessageProps)

		if (await this.shouldAutoApproveToolWithPath(block.name, block.params.path)) {
			await this.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await this.say("tool" as ClineSay, partialMessage, undefined, undefined, block.partial)
		} else {
			await this.removeLastPartialMessageIfExistsWithType("say", "tool")
			await this.ask("tool" as ClineAsk, partialMessage, block.partial).catch(() => {})
		}

		// Now handle the actual streaming of content to the diff view
		try {
			// Construct newContent from diff or content
			let newContent: string = ""

			if (diff) {
				// Handle replace_in_file with diff construction
				if (!this.config.api.getModel().id.includes("claude")) {
					// deepseek models tend to use unescaped html entities in diffs
					const { fixModelHtmlEscaping, removeInvalidChars } = require("@utils/string")
					diff = fixModelHtmlEscaping(diff)
					diff = removeInvalidChars(diff)
				}

				// Open the editor if not done already
				if (!this.config.services.diffViewProvider.isEditing) {
					await this.config.services.diffViewProvider.open(relPath)
				}

				// For partial diffs, we need to construct the content incrementally
				// We'll use constructNewFileContent with partial flag
				const { constructNewFileContent } = require("@core/assistant-message/diff")
				try {
					newContent = await constructNewFileContent(
						diff,
						this.config.services.diffViewProvider.originalContent || "",
						!block.partial, // Pass the partial flag correctly
					)
				} catch (error) {
					// For partial blocks, we might get incomplete diffs, so we'll just skip errors
					// and wait for more content
					if (!block.partial) {
						throw error
					}
					return
				}
			} else if (content) {
				// Handle write_to_file with direct content
				newContent = content

				// Pre-processing newContent for cases where weaker models might add artifacts
				if (newContent.startsWith("```")) {
					newContent = newContent.split("\n").slice(1).join("\n").trim()
				}
				if (newContent.endsWith("```")) {
					newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
				}

				if (!this.config.api.getModel().id.includes("claude")) {
					const { fixModelHtmlEscaping, removeInvalidChars } = require("@utils/string")
					newContent = fixModelHtmlEscaping(newContent)
					newContent = removeInvalidChars(newContent)
				}
			}

			// Open the editor if not already open
			if (!this.config.services.diffViewProvider.isEditing) {
				await this.config.services.diffViewProvider.open(relPath)
			}

			// Stream the content to the diff view (false = don't finalize yet)
			await this.config.services.diffViewProvider.update(newContent, false)
		} catch (error) {
			// For partial blocks, we'll silently handle errors and wait for more content
			// The complete block handler will handle actual errors
			if (!block.partial) {
				console.error("Error in partial write tool block:", error)
			}
		}
	}

	/**
	 * Handle complete block execution with approval flow
	 */
	private async handleCompleteBlock(block: ToolUse): Promise<void> {
		// Handle different tool types with their specific approval flows
		switch (block.name) {
			case "read_file":
			case "list_files":
			case "list_code_definition_names":
			case "search_files":
				await this.handleFileToolExecution(block)
				break
			case "write_to_file":
			case "replace_in_file":
			case "new_rule":
				await this.handleWriteToolExecution(block)
				break
			case "use_mcp_tool":
			case "access_mcp_resource":
				await this.handleMcpToolExecution(block)
				break
			case "load_mcp_documentation":
				await this.handleLoadMcpDocumentationExecution(block)
				break
			case "plan_mode_respond":
			case "attempt_completion":
			case "new_task":
				await this.handleTaskManagementExecution(block)
				break
			case "condense":
			case "report_bug":
				await this.handleContextAndUtilityExecution(block)
				break
			case "summarize_task":
				// This tool is fully self-managed with IPartialBlockHandler
				await ToolExecutionStrategies.executeSimpleTool(block, this.coordinator, this.config, this.pushToolResult)
				break
			case "ask_followup_question":
			case "browser_action":
				// These tools are fully self-managed
				const result = await this.coordinator.execute(this.config, block)
				this.pushToolResult(result, block)
				break
			default:
				// For any other tools that might be added, just execute and push result
				await ToolExecutionStrategies.executeSimpleTool(block, this.coordinator, this.config, this.pushToolResult)
				break
		}

		// Handle focus chain updates
		if (!block.partial && this.config.focusChainSettings.enabled) {
			await this.updateFCListFromToolResponse(block.params.task_progress)
		}

		await this.saveCheckpoint()
	}

	/**
	 * Handle execution of file-related tools (read_file, list_files)
	 */
	private async handleFileToolExecution(block: ToolUse): Promise<void> {
		const relPath = block.params.path

		// Execute the tool to get the result (handlers validate params and check clineignore)
		const result = await this.coordinator.execute(this.config, block)

		// Handle validation errors using the error handler
		if (
			await ToolErrorHandler.handleValidationError(
				block,
				result,
				this.config,
				this.pushToolResult,
				this.saveCheckpoint,
				this.sayAndCreateMissingParamError,
			)
		) {
			return // Error was handled
		}

		const absolutePath = path.resolve(this.config.cwd, relPath || "")
		const tool = ToolDisplayUtils.getToolDisplayName(block)

		// Handle approval flow using the approval manager
		const approved = await this.approvalManager.handleFileToolApproval(block, relPath || "", absolutePath, tool, result)
		if (!approved) {
			await this.saveCheckpoint()
			return
		}

		// Tool was approved, push the result
		this.pushToolResult(result, block)
	}

	/**
	 * Handle execution of write-related tools (write_to_file, replace_in_file, new_rule)
	 */
	private async handleWriteToolExecution(block: ToolUse): Promise<void> {
		const relPath = block.params.path
		const content = block.params.content || block.params.diff

		// Validate path parameter using error handler
		if (
			await ToolErrorHandler.handleValidationError(
				block,
				null, // No result yet, just checking params
				this.config,
				this.pushToolResult,
				this.saveCheckpoint,
				this.sayAndCreateMissingParamError,
			)
		) {
			return // Error was handled
		}

		// Check if file exists for UI messaging
		const absolutePath = path.resolve(this.config.cwd, relPath || "")
		const fileExists =
			this.config.services.diffViewProvider.editType === "modify" || (await this.config.services.diffViewProvider.isEditing)
				? this.config.services.diffViewProvider.editType === "modify"
				: await require("@utils/fs").fileExistsAtPath(absolutePath)

		// Handle approval flow using the approval manager with detailed feedback support
		const approvalResult = await this.approvalManager.handleWriteToolApproval(
			block,
			relPath || "",
			fileExists,
			content || "",
			this.pushToolResult,
			this.saveCheckpoint,
		)

		if (!approvalResult.approved) {
			// Reset diff view if user rejected
			await ToolErrorHandler.handleDiffViewReset(this.config)
			// If rejection was already handled (with detailed message), just return
			if (approvalResult.rejectionHandled) {
				return
			}
			// Otherwise push a simple rejection message
			this.pushToolResult("The user rejected this operation.", block)
			return
		}

		// User approved or auto-approved, now execute the tool
		const result = await this.coordinator.execute(this.config, block)

		// Check if handler returned an error
		if (ToolValidationUtils.isValidationError(result)) {
			this.pushToolResult(result, block)
			return
		}

		// Push the successful result
		this.pushToolResult(result, block)
	}

	/**
	 * Handle execution of MCP tools (use_mcp_tool, access_mcp_resource)
	 */
	private async handleMcpToolExecution(block: ToolUse): Promise<void> {
		// Handle approval flow using the approval manager
		const approved = await this.approvalManager.handleMcpToolApproval(block)
		if (!approved) {
			return
		}

		// Show MCP request started message
		await this.say("mcp_server_request_started" as ClineSay)

		// Execute the MCP tool through the handler
		const result = await this.coordinator.execute(this.config, block)

		// Check if handler returned an error
		if (ToolValidationUtils.isValidationError(result)) {
			this.pushToolResult(result, block)
			return
		}

		// Push the successful result
		this.pushToolResult(result, block)
	}

	/**
	 * Handle execution of load_mcp_documentation tool
	 */
	private async handleLoadMcpDocumentationExecution(block: ToolUse): Promise<void> {
		await ToolExecutionStrategies.executeToolWithLoadingMessage(
			block,
			this.coordinator,
			this.config,
			this.pushToolResult,
			this.say,
			"load_mcp_documentation" as ClineSay,
		)
	}

	/**
	 * Handle execution of task management tools (plan_mode_respond, attempt_completion, new_task)
	 */
	private async handleTaskManagementExecution(block: ToolUse): Promise<void> {
		await ToolExecutionStrategies.executeToolWithValidation(block, this.coordinator, this.config, this.pushToolResult)
	}

	/**
	 * Handle execution of context and utility tools (condense, summarize_task, report_bug)
	 */
	private async handleContextAndUtilityExecution(block: ToolUse): Promise<void> {
		await ToolExecutionStrategies.executeToolWithValidation(block, this.coordinator, this.config, this.pushToolResult)
	}
}
