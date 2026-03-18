/**
 * Every HTTP route Pie serves, mapped to the handler that answers it.
 *
 * Routes without a path parameter register first, so a literal segment such as
 * `/api/sessions/ui-state` can never be read as `/api/sessions/:id`. Each handler keeps the
 * `(request, context)` shape (see `./http.ts`), which is why the routes stay plain
 * functions that a caller can invoke without a server.
 */
import type { Hono } from 'hono';
import { toHono } from './hono-route';

import * as agentById from './api/agent/[id]/route';
import * as agentByIdBashOutput from './api/agent/[id]/bash-output/route';
import * as agentByIdEvents from './api/agent/[id]/events/route';
import * as agentByIdLease from './api/agent/[id]/lease/route';
import * as agentNew from './api/agent/new/route';
import * as agentRunning from './api/agent/running/route';
import * as authApiKeyByProvider from './api/auth/api-key/[provider]/route';
import * as authLoginByProvider from './api/auth/login/[provider]/route';
import * as authLogoutByProvider from './api/auth/logout/[provider]/route';
import * as authProviders from './api/auth/providers/route';
import * as cacheMissNotices from './api/cache-miss-notices/route';
import * as cwdBrowse from './api/cwd/browse/route';
import * as cwdValidate from './api/cwd/validate/route';
import * as defaultCwd from './api/default-cwd/route';
import * as fileIndex from './api/file-index/route';
import * as filesPath from './api/files/[...path]/route';
import * as globalAgents from './api/global-agents/route';
import * as home from './api/home/route';
import * as mcp from './api/mcp/route';
import * as mcpSignIn from './api/mcp/sign-in/route';
import * as mcpSignInByFlowId from './api/mcp/sign-in/[flowId]/route';
import * as mcpTest from './api/mcp/test/route';
import * as models from './api/models/route';
import * as modelsConfig from './api/models-config/route';
import * as modelsConfigCatalog from './api/models-config/catalog/route';
import * as modelsConfigDiscover from './api/models-config/discover/route';
import * as modelsConfigTest from './api/models-config/test/route';
import * as modelsContextLimit from './api/models/context-limit/route';
import * as modelsDefault from './api/models/default/route';
import * as modelsEnabled from './api/models/enabled/route';
import * as modelsRefresh from './api/models/refresh/route';
import * as modelsThinking from './api/models/thinking/route';
import * as plugins from './api/plugins/route';
import * as pluginsCheck from './api/plugins/check/route';
import * as projectTrust from './api/project-trust/route';
import * as providerUsageQuery from './api/provider-usage/query/route';
import * as pushConfig from './api/push/config/route';
import * as pushSubscribe from './api/push/subscribe/route';
import * as sessions from './api/sessions/route';
import * as sessionsById from './api/sessions/[id]/route';
import * as sessionsByIdAutoName from './api/sessions/[id]/auto-name/route';
import * as sessionsByIdContext from './api/sessions/[id]/context/route';
import * as sessionsByIdEntriesByEntryIdThinking from './api/sessions/[id]/entries/[entryId]/thinking/route';
import * as sessionsByIdEntriesByEntryIdToolResultImage from './api/sessions/[id]/entries/[entryId]/tool-result-image/route';
import * as sessionsByIdExport from './api/sessions/[id]/export/route';
import * as sessionsByIdFork from './api/sessions/[id]/fork/route';
import * as sessionsByIdState from './api/sessions/[id]/state/route';
import * as sessionsDelete from './api/sessions/delete/route';
import * as sessionsSearch from './api/sessions/search/route';
import * as sessionsStats from './api/sessions/stats/route';
import * as sessionsUiState from './api/sessions/ui-state/route';
import * as skills from './api/skills/route';
import * as skillsCheck from './api/skills/check/route';
import * as skillsContent from './api/skills/content/route';
import * as skillsInstall from './api/skills/install/route';
import * as skillsSearch from './api/skills/search/route';
import * as skillsUpdate from './api/skills/update/route';
import * as tasks from './api/tasks/route';
import * as tasksById from './api/tasks/[id]/route';
import * as tasksByIdAnswer from './api/tasks/[id]/answer/route';
import * as tasksByIdOutput from './api/tasks/[id]/output/route';
import * as tasksConfig from './api/tasks/config/route';
import * as tasksControl from './api/tasks/control/route';
import * as toolsPresets from './api/tools/presets/route';
import * as toolsSettings from './api/tools/settings/route';
import * as webAuth from './api/web-auth/route';

export function registerApiRoutes(app: Hono): void {
  // server/api/agent/new/route.ts
  app.post('/api/agent/new', toHono(agentNew.POST));

  // server/api/agent/running/route.ts
  app.get('/api/agent/running', toHono(agentRunning.GET));

  // server/api/auth/providers/route.ts
  app.get('/api/auth/providers', toHono(authProviders.GET));

  // server/api/cache-miss-notices/route.ts
  app.get('/api/cache-miss-notices', toHono(cacheMissNotices.GET));
  app.put('/api/cache-miss-notices', toHono(cacheMissNotices.PUT));

  // server/api/cwd/browse/route.ts
  app.get('/api/cwd/browse', toHono(cwdBrowse.GET));
  app.post('/api/cwd/browse', toHono(cwdBrowse.POST));

  // server/api/cwd/validate/route.ts
  app.post('/api/cwd/validate', toHono(cwdValidate.POST));

  // server/api/default-cwd/route.ts
  app.post('/api/default-cwd', toHono(defaultCwd.POST));

  // server/api/file-index/route.ts
  app.get('/api/file-index', toHono(fileIndex.GET));

  // server/api/global-agents/route.ts
  app.get('/api/global-agents', toHono(globalAgents.GET));
  app.put('/api/global-agents', toHono(globalAgents.PUT));

  // server/api/home/route.ts
  app.get('/api/home', toHono(home.GET));

  // server/api/mcp/route.ts
  app.get('/api/mcp', toHono(mcp.GET));
  app.post('/api/mcp', toHono(mcp.POST));

  // server/api/mcp/sign-in/route.ts
  app.post('/api/mcp/sign-in', toHono(mcpSignIn.POST));

  // server/api/mcp/test/route.ts
  app.post('/api/mcp/test', toHono(mcpTest.POST));

  // server/api/models/route.ts
  app.get('/api/models', toHono(models.GET));

  // server/api/models-config/route.ts
  app.get('/api/models-config', toHono(modelsConfig.GET));
  app.put('/api/models-config', toHono(modelsConfig.PUT));

  // server/api/models-config/catalog/route.ts
  app.get('/api/models-config/catalog', toHono(modelsConfigCatalog.GET));

  // server/api/models-config/discover/route.ts
  app.post('/api/models-config/discover', toHono(modelsConfigDiscover.POST));

  // server/api/models-config/test/route.ts
  app.post('/api/models-config/test', toHono(modelsConfigTest.POST));

  // server/api/models/context-limit/route.ts
  app.get('/api/models/context-limit', toHono(modelsContextLimit.GET));
  app.put('/api/models/context-limit', toHono(modelsContextLimit.PUT));

  // server/api/models/default/route.ts
  app.put('/api/models/default', toHono(modelsDefault.PUT));

  // server/api/models/enabled/route.ts
  app.get('/api/models/enabled', toHono(modelsEnabled.GET));
  app.put('/api/models/enabled', toHono(modelsEnabled.PUT));

  // server/api/models/refresh/route.ts
  app.post('/api/models/refresh', toHono(modelsRefresh.POST));

  // server/api/models/thinking/route.ts
  app.put('/api/models/thinking', toHono(modelsThinking.PUT));

  // server/api/plugins/route.ts
  app.get('/api/plugins', toHono(plugins.GET));
  app.post('/api/plugins', toHono(plugins.POST));

  // server/api/plugins/check/route.ts
  app.post('/api/plugins/check', toHono(pluginsCheck.POST));

  // server/api/project-trust/route.ts
  app.get('/api/project-trust', toHono(projectTrust.GET));
  app.post('/api/project-trust', toHono(projectTrust.POST));

  // server/api/provider-usage/query/route.ts
  app.post('/api/provider-usage/query', toHono(providerUsageQuery.POST));

  // server/api/push/config/route.ts
  app.get('/api/push/config', toHono(pushConfig.GET));

  // server/api/push/subscribe/route.ts
  app.post('/api/push/subscribe', toHono(pushSubscribe.POST));

  // server/api/sessions/route.ts
  app.get('/api/sessions', toHono(sessions.GET));

  // server/api/sessions/delete/route.ts
  app.post('/api/sessions/delete', toHono(sessionsDelete.POST));

  // server/api/sessions/search/route.ts
  app.get('/api/sessions/search', toHono(sessionsSearch.GET));

  // server/api/sessions/stats/route.ts
  app.post('/api/sessions/stats', toHono(sessionsStats.POST));

  // server/api/sessions/ui-state/route.ts
  app.get('/api/sessions/ui-state', toHono(sessionsUiState.GET));
  app.post('/api/sessions/ui-state', toHono(sessionsUiState.POST));

  // server/api/skills/route.ts
  app.get('/api/skills', toHono(skills.GET));
  app.patch('/api/skills', toHono(skills.PATCH));

  // server/api/skills/check/route.ts
  app.post('/api/skills/check', toHono(skillsCheck.POST));

  // server/api/skills/content/route.ts
  app.get('/api/skills/content', toHono(skillsContent.GET));

  // server/api/skills/install/route.ts
  app.post('/api/skills/install', toHono(skillsInstall.POST));

  // server/api/skills/search/route.ts
  app.post('/api/skills/search', toHono(skillsSearch.POST));

  // server/api/skills/update/route.ts
  app.post('/api/skills/update', toHono(skillsUpdate.POST));

  // server/api/tasks/route.ts
  app.get('/api/tasks', toHono(tasks.GET));
  app.post('/api/tasks', toHono(tasks.POST));

  // server/api/tasks/config/route.ts
  app.get('/api/tasks/config', toHono(tasksConfig.GET));
  app.put('/api/tasks/config', toHono(tasksConfig.PUT));

  // server/api/tasks/control/route.ts
  app.post('/api/tasks/control', toHono(tasksControl.POST));

  // server/api/tools/presets/route.ts
  app.get('/api/tools/presets', toHono(toolsPresets.GET));
  app.put('/api/tools/presets', toHono(toolsPresets.PUT));

  // server/api/tools/settings/route.ts
  app.get('/api/tools/settings', toHono(toolsSettings.GET));
  app.put('/api/tools/settings', toHono(toolsSettings.PUT));

  // server/api/web-auth/route.ts
  app.get('/api/web-auth', toHono(webAuth.GET));
  app.post('/api/web-auth', toHono(webAuth.POST));
  app.delete('/api/web-auth', toHono(webAuth.DELETE));

  // server/api/agent/[id]/route.ts
  app.get('/api/agent/:id', toHono(agentById.GET));
  app.post('/api/agent/:id', toHono(agentById.POST));

  // server/api/agent/[id]/bash-output/route.ts
  app.get('/api/agent/:id/bash-output', toHono(agentByIdBashOutput.GET));

  // server/api/agent/[id]/events/route.ts
  app.get('/api/agent/:id/events', toHono(agentByIdEvents.GET));

  // server/api/agent/[id]/lease/route.ts
  app.post('/api/agent/:id/lease', toHono(agentByIdLease.POST));

  // server/api/auth/api-key/[provider]/route.ts
  app.post('/api/auth/api-key/:provider', toHono(authApiKeyByProvider.POST));
  app.delete('/api/auth/api-key/:provider', toHono(authApiKeyByProvider.DELETE));

  // server/api/auth/login/[provider]/route.ts
  app.get('/api/auth/login/:provider', toHono(authLoginByProvider.GET));
  app.post('/api/auth/login/:provider', toHono(authLoginByProvider.POST));

  // server/api/auth/logout/[provider]/route.ts
  app.post('/api/auth/logout/:provider', toHono(authLogoutByProvider.POST));

  // server/api/files/[...path]/route.ts
  app.get('/api/files/*', toHono(filesPath.GET));
  app.post('/api/files/*', toHono(filesPath.POST));

  // server/api/mcp/sign-in/[flowId]/route.ts
  app.get('/api/mcp/sign-in/:flowId', toHono(mcpSignInByFlowId.GET));
  app.post('/api/mcp/sign-in/:flowId', toHono(mcpSignInByFlowId.POST));
  app.delete('/api/mcp/sign-in/:flowId', toHono(mcpSignInByFlowId.DELETE));

  // server/api/sessions/[id]/route.ts
  app.get('/api/sessions/:id', toHono(sessionsById.GET));
  app.patch('/api/sessions/:id', toHono(sessionsById.PATCH));
  app.delete('/api/sessions/:id', toHono(sessionsById.DELETE));

  // server/api/sessions/[id]/auto-name/route.ts
  app.post('/api/sessions/:id/auto-name', toHono(sessionsByIdAutoName.POST));

  // server/api/sessions/[id]/context/route.ts
  app.get('/api/sessions/:id/context', toHono(sessionsByIdContext.GET));

  // server/api/sessions/[id]/entries/[entryId]/thinking/route.ts
  app.get('/api/sessions/:id/entries/:entryId/thinking', toHono(sessionsByIdEntriesByEntryIdThinking.GET));

  // server/api/sessions/[id]/entries/[entryId]/tool-result-image/route.ts
  app.get('/api/sessions/:id/entries/:entryId/tool-result-image', toHono(sessionsByIdEntriesByEntryIdToolResultImage.GET));

  // server/api/sessions/[id]/export/route.ts
  app.get('/api/sessions/:id/export', toHono(sessionsByIdExport.GET));

  // server/api/sessions/[id]/fork/route.ts
  app.post('/api/sessions/:id/fork', toHono(sessionsByIdFork.POST));

  // server/api/sessions/[id]/state/route.ts
  app.get('/api/sessions/:id/state', toHono(sessionsByIdState.GET));

  // server/api/tasks/[id]/route.ts
  app.get('/api/tasks/:id', toHono(tasksById.GET));
  app.patch('/api/tasks/:id', toHono(tasksById.PATCH));
  app.delete('/api/tasks/:id', toHono(tasksById.DELETE));

  // server/api/tasks/[id]/answer/route.ts
  app.post('/api/tasks/:id/answer', toHono(tasksByIdAnswer.POST));

  // server/api/tasks/[id]/output/route.ts
  app.get('/api/tasks/:id/output', toHono(tasksByIdOutput.GET));
}
