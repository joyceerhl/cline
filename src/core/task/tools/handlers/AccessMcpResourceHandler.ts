import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import type { ToolResponse } from "../../index"
import type { IToolHandler } from "../ToolExecutorCoordinator"

export class AccessMcpResourceHandler implements IToolHandler {
	readonly name = "access_mcp_resource"

	constructor() {}

	async execute(config: any, block: ToolUse): Promise<ToolResponse> {
		// For partial blocks, don't execute yet (manager handles partial UI)
		if (block.partial) {
			return ""
		}

		const server_name: string | undefined = block.params.server_name
		const uri: string | undefined = block.params.uri

		// Validate required parameters - return validation errors for manager to detect
		if (!server_name) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError("access_mcp_resource", "server_name")
		}

		if (!uri) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError("access_mcp_resource", "uri")
		}

		config.taskState.consecutiveMistakeCount = 0

		try {
			// Execute the MCP resource access
			const resourceResult = await config.services.mcpHub.readResource(server_name, uri)

			// Process the resource result
			const resourceResultPretty =
				resourceResult?.contents
					.map((item: any) => {
						if (item.text) {
							return item.text
						}
						return ""
					})
					.filter(Boolean)
					.join("\n\n") || "(Empty response)"

			// Display result to user
			await config.callbacks.say("mcp_server_response", resourceResultPretty)

			// Return formatted result for the manager to push
			return formatResponse.toolResult(resourceResultPretty)
		} catch (error) {
			// Return error string for manager to detect and handle
			return `Error accessing MCP resource: ${(error as Error)?.message}`
		}
	}
}
