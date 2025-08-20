import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { telemetryService } from "@services/posthog/PostHogClientProvider"
import { ClineAsk, ClineSay } from "@shared/ExtensionMessage"
import { ClineAskResponse } from "@shared/WebviewMessage"
import { getReadablePath, isLocatedInWorkspace } from "@utils/path"
import * as path from "path"
import { ToolUse, ToolUseName } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { showNotificationForApprovalIfAutoApprovalEnabled } from "../../utils"

/**
 * Manages the approval flow for tool executions, including auto-approval logic,
 * notification generation, telemetry capture, and UI message routing.
 */
export class ToolApprovalManager {
	constructor(
		private config: any,
		private shouldAutoApproveToolWithPath: (toolName: ToolUseName, path?: string) => Promise<boolean>,
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
	) {}

	/**
	 * Handle approval flow for file-related tools (read_file, list_files, etc.)
	 */
	async handleFileToolApproval(
		block: ToolUse,
		relPath: string,
		absolutePath: string,
		tool: string,
		result: any,
	): Promise<boolean> {
		const sharedMessageProps = {
			tool,
			path: getReadablePath(this.config.cwd, relPath),
			content: block.name === "list_files" ? result : absolutePath,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		}

		const completeMessage = JSON.stringify(sharedMessageProps)

		if (await this.shouldAutoApproveToolWithPath(block.name, block.params.path)) {
			await this.handleAutoApproval("tool", completeMessage, block)
			return true
		} else {
			const notificationMessage = this.createFileToolNotificationMessage(block, absolutePath)
			return await this.handleManualApproval("tool", completeMessage, block, notificationMessage)
		}
	}

	/**
	 * Handle approval flow for write-related tools (write_to_file, replace_in_file, new_rule)
	 * Returns an object with approval status and any rejection message
	 */
	async handleWriteToolApproval(
		block: ToolUse,
		relPath: string,
		fileExists: boolean,
		content: string,
		pushToolResult: (content: any, block: ToolUse) => void,
		saveCheckpoint: () => Promise<void>,
	): Promise<{ approved: boolean; rejectionHandled?: boolean }> {
		const sharedMessageProps = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(this.config.cwd, relPath),
			content: content,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		}

		const completeMessage = JSON.stringify(sharedMessageProps)

		if (await this.shouldAutoApproveToolWithPath(block.name, relPath)) {
			await this.handleAutoApproval("tool", completeMessage, block)
			// Add diagnostic delay after auto-approval
			await setTimeoutPromise(3_500)
			return { approved: true }
		} else {
			const notificationMessage = `Cline wants to ${fileExists ? "edit" : "create"} ${path.basename(relPath)}`
			return await this.handleManualWriteApproval(
				"tool",
				completeMessage,
				block,
				notificationMessage,
				fileExists,
				pushToolResult,
				saveCheckpoint,
			)
		}
	}

	/**
	 * Handle approval flow for MCP tools (use_mcp_tool, access_mcp_resource)
	 */
	async handleMcpToolApproval(block: ToolUse): Promise<boolean> {
		const server_name = block.params.server_name
		const tool_name = block.params.tool_name
		const uri = block.params.uri
		const mcp_arguments = block.params.arguments

		const completeMessage = JSON.stringify({
			type: block.name === "use_mcp_tool" ? "use_mcp_tool" : "access_mcp_resource",
			serverName: server_name,
			toolName: tool_name,
			uri: uri,
			arguments: mcp_arguments,
		})

		const shouldAutoApprove = this.shouldAutoApproveMcpTool(block, server_name || "", tool_name || "")

		if (shouldAutoApprove) {
			await this.handleAutoApproval("use_mcp_server", completeMessage, block)
			return true
		} else {
			const notificationMessage = this.createMcpToolNotificationMessage(block, tool_name, server_name, uri)
			return await this.handleManualApproval("use_mcp_server", completeMessage, block, notificationMessage)
		}
	}

	/**
	 * Handle auto-approval flow
	 */
	private async handleAutoApproval(messageType: string, message: string, block: ToolUse): Promise<void> {
		await this.removeLastPartialMessageIfExistsWithType("ask", messageType)
		await this.say(messageType as ClineSay, message, undefined, undefined, false)
		this.config.taskState.consecutiveAutoApprovedRequestsCount++
		this.captureTelemetry(block, true, true)
	}

	/**
	 * Handle manual approval flow
	 */
	private async handleManualApproval(
		messageType: string,
		message: string,
		block: ToolUse,
		notificationMessage: string,
	): Promise<boolean> {
		showNotificationForApprovalIfAutoApprovalEnabled(
			notificationMessage,
			this.config.autoApprovalSettings.enabled,
			this.config.autoApprovalSettings.enableNotifications,
		)

		await this.removeLastPartialMessageIfExistsWithType("say", messageType)
		const didApprove = await this.askApproval(messageType as ClineAsk, block, message)

		if (!didApprove) {
			this.captureTelemetry(block, false, false)
			return false
		}

		this.captureTelemetry(block, false, true)
		return true
	}

	/**
	 * Handle manual approval flow for write tools with detailed feedback
	 */
	private async handleManualWriteApproval(
		messageType: string,
		message: string,
		block: ToolUse,
		notificationMessage: string,
		fileExists: boolean,
		pushToolResult: (content: any, block: ToolUse) => void,
		saveCheckpoint: () => Promise<void>,
	): Promise<{ approved: boolean; rejectionHandled?: boolean }> {
		showNotificationForApprovalIfAutoApprovalEnabled(
			notificationMessage,
			this.config.autoApprovalSettings.enabled,
			this.config.autoApprovalSettings.enableNotifications,
		)

		await this.removeLastPartialMessageIfExistsWithType("say", messageType)

		// Ask for approval with full context
		const { response, text, images, files } = await this.ask(messageType as ClineAsk, message, false)

		if (response !== "yesButtonClicked") {
			// User either sent a message or pressed reject button
			const fileDeniedNote = fileExists
				? "The file was not updated, and maintains its original contents."
				: "The file was not created."
			pushToolResult(`The user denied this operation. ${fileDeniedNote}`, block)

			// Process additional feedback if provided
			if (text || (images && images.length > 0) || (files && files.length > 0)) {
				let fileContentString = ""
				if (files && files.length > 0) {
					fileContentString = await processFilesIntoText(files)
				}

				// Push additional feedback to tool result
				const feedbackContent = formatResponse.toolResult(
					`The user provided feedback on the denied operation:\n<feedback>\n${text}\n</feedback>`,
					images,
					fileContentString,
				)
				pushToolResult(feedbackContent, block)

				await this.say("user_feedback", text, images, files)
				await saveCheckpoint()
			}

			// Set the rejection flag
			this.config.taskState.didRejectTool = true
			this.captureTelemetry(block, false, false)
			return { approved: false, rejectionHandled: true }
		} else {
			// User hit the approve button, may have provided feedback
			if (text || (images && images.length > 0) || (files && files.length > 0)) {
				let fileContentString = ""
				if (files && files.length > 0) {
					fileContentString = await processFilesIntoText(files)
				}

				// Push additional feedback to tool result
				const feedbackContent = formatResponse.toolResult(
					`The user provided feedback:\n<feedback>\n${text}\n</feedback>`,
					images,
					fileContentString,
				)
				pushToolResult(feedbackContent, block)

				await this.say("user_feedback", text, images, files)
				await saveCheckpoint()
			}

			this.captureTelemetry(block, false, true)
			return { approved: true }
		}
	}

	/**
	 * Determine if MCP tool should be auto-approved
	 */
	private shouldAutoApproveMcpTool(block: ToolUse, server_name: string, tool_name: string): boolean {
		if (block.name === "use_mcp_tool") {
			// Check if this specific tool is auto-approved on the server
			const isToolAutoApproved = this.config.services.mcpHub.connections
				?.find((conn: any) => conn.server.name === server_name)
				?.server.tools?.find((tool: any) => tool.name === tool_name)?.autoApprove

			return this.config.autoApprovalSettings.enabled && isToolAutoApproved
		} else {
			// access_mcp_resource uses general auto-approval
			return this.config.autoApprovalSettings.enabled
		}
	}

	/**
	 * Create notification message for file tools
	 */
	private createFileToolNotificationMessage(block: ToolUse, absolutePath: string): string {
		return block.name === "list_files"
			? `Cline wants to view directory ${path.basename(absolutePath)}/`
			: `Cline wants to read ${path.basename(absolutePath)}`
	}

	/**
	 * Create notification message for MCP tools
	 */
	private createMcpToolNotificationMessage(
		block: ToolUse,
		tool_name: string | undefined,
		server_name: string | undefined,
		uri: string | undefined,
	): string {
		return block.name === "use_mcp_tool"
			? `Cline wants to use ${tool_name || "unknown tool"} on ${server_name || "unknown server"}`
			: `Cline wants to access ${uri || "unknown resource"} on ${server_name || "unknown server"}`
	}

	/**
	 * Capture telemetry for tool usage
	 */
	private captureTelemetry(block: ToolUse, isAutoApproved: boolean, wasApproved: boolean): void {
		telemetryService.captureToolUsage(
			this.config.ulid,
			block.name,
			this.config.api.getModel().id,
			isAutoApproved,
			wasApproved,
		)
	}
}
