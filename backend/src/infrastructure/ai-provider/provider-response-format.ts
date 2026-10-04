const pathSchema = { type: 'string', minLength: 1, maxLength: 512 };
const summarySchema = { type: 'string', maxLength: 240 };

const changeSchema = {
  anyOf: [
    {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'edit', 'overwrite'] },
        path: pathSchema,
        content: { type: 'string', maxLength: 128 * 1024 },
        summary: summarySchema
      },
      required: ['operation', 'path', 'content', 'summary'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['rename'] },
        path: pathSchema,
        destinationPath: pathSchema,
        summary: summarySchema
      },
      required: ['operation', 'path', 'destinationPath', 'summary'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['delete'] },
        path: pathSchema,
        summary: summarySchema
      },
      required: ['operation', 'path', 'summary'],
      additionalProperties: false
    }
  ]
};

/** Constrains generation; local validation still enforces file safety and byte limits. */
export const NVIDIA_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'project_assistant_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', maxLength: 64 * 1024 },
        changes: { type: 'array', maxItems: 100, items: changeSchema },
        taskSuggestions: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 120 },
              details: { type: 'string', maxLength: 4096 },
              subtasks: {
                type: 'array', maxItems: 50,
                items: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['title'], additionalProperties: false }
              }
            },
            required: ['title', 'details', 'subtasks'],
            additionalProperties: false
          }
        }
      },
      required: ['message', 'changes', 'taskSuggestions'],
      additionalProperties: false
    }
  }
} as const;
