import { useRef, useState } from "react";
import { Concept01Query } from "./concepts/Concept01Query";
import { Concept02Options } from "./concepts/Concept02Options";
import { Concept03Tools } from "./concepts/Concept03Tools";
import { Concept04Permissions } from "./concepts/Concept04Permissions";
import { Concept05CustomTools } from "./concepts/Concept05CustomTools";
import { Concept06Sessions } from "./concepts/Concept06Sessions";
import { Concept07Hooks } from "./concepts/Concept07Hooks";
import { Concept08Subagents } from "./concepts/Concept08Subagents";
import { Concept09SystemPrompts } from "./concepts/Concept09SystemPrompts";
import { Concept10StructuredInterrupt } from "./concepts/Concept10StructuredInterrupt";
import { Concept11Skills } from "./concepts/Concept11Skills";
import { Concept12StreamingInput } from "./concepts/Concept12StreamingInput";
import { Concept13McpServers } from "./concepts/Concept13McpServers";
import { Concept14ThinkingEffortModels } from "./concepts/Concept14ThinkingEffortModels";
import { Concept15CostUsage } from "./concepts/Concept15CostUsage";
import { Concept16SettingsEnv } from "./concepts/Concept16SettingsEnv";
import { Concept17Checkpointing } from "./concepts/Concept17Checkpointing";
import { Concept18Sandbox } from "./concepts/Concept18Sandbox";
import { Concept19SessionManagement } from "./concepts/Concept19SessionManagement";
import { Concept20HooksInDepth } from "./concepts/Concept20HooksInDepth";
import { Concept21SlashCommands } from "./concepts/Concept21SlashCommands";
import { Concept22ClaudeMdMemory } from "./concepts/Concept22ClaudeMdMemory";
import { Concept23Plugins } from "./concepts/Concept23Plugins";
import { Concept24Harnesses } from "./concepts/Concept24Harnesses";
import { Concept25CompactionContext } from "./concepts/Concept25CompactionContext";
import { Concept26QueryControl } from "./concepts/Concept26QueryControl";
import { Concept27BackgroundTasks } from "./concepts/Concept27BackgroundTasks";
import { Concept28ErrorsRetries } from "./concepts/Concept28ErrorsRetries";
import { Concept29ImagesFiles } from "./concepts/Concept29ImagesFiles";
import { Concept30TodoTracking } from "./concepts/Concept30TodoTracking";
import { Concept31AskUserQuestion } from "./concepts/Concept31AskUserQuestion";
import { Concept32PlanMode } from "./concepts/Concept32PlanMode";
import { Concept33McpElicitation } from "./concepts/Concept33McpElicitation";
import { Concept34OutputStyles } from "./concepts/Concept34OutputStyles";
import { Concept35SessionStores } from "./concepts/Concept35SessionStores";
import { Concept36ProcessSpawning } from "./concepts/Concept36ProcessSpawning";
import { Concept37PermissionPromptTool } from "./concepts/Concept37PermissionPromptTool";
import { Concept38PromptSuggestions } from "./concepts/Concept38PromptSuggestions";
import { Concept39ProjectConfigRoot } from "./concepts/Concept39ProjectConfigRoot";
import { Concept40ResumeDropsTurn } from "./concepts/Concept40ResumeDropsTurn";
import { Concept41V2SessionApi } from "./concepts/Concept41V2SessionApi";
import { Concept42WebTools } from "./concepts/Concept42WebTools";
import { Concept43RemoteMcp } from "./concepts/Concept43RemoteMcp";
import { Concept44OtelObservability } from "./concepts/Concept44OtelObservability";
import { Concept45CloudProviders } from "./concepts/Concept45CloudProviders";
import { Concept46PromptCaching } from "./concepts/Concept46PromptCaching";
import { Concept47MultiAgent } from "./concepts/Concept47MultiAgent";
import { Concept48SecurityHardening } from "./concepts/Concept48SecurityHardening";
import { Concept49DeployCiHeadless } from "./concepts/Concept49DeployCiHeadless";
import { Concept50Capstone } from "./concepts/Concept50Capstone";
import { Concept51UnitTesting } from "./concepts/Concept51UnitTesting";
import { Concept52Evals } from "./concepts/Concept52Evals";
import { Concept53Debugging } from "./concepts/Concept53Debugging";
import { Concept54ToolDesign } from "./concepts/Concept54ToolDesign";
import { Concept55UpgradingSdk } from "./concepts/Concept55UpgradingSdk";
import { Concept56AgentTeams } from "./concepts/Concept56AgentTeams";
import { Concept57ParallelWorktrees } from "./concepts/Concept57ParallelWorktrees";
import { Concept58ToolSearch } from "./concepts/Concept58ToolSearch";
import { Concept59ModelRouting } from "./concepts/Concept59ModelRouting";
import { Concept60DurableAgents } from "./concepts/Concept60DurableAgents";
import { Concept61AgentMcpServer } from "./concepts/Concept61AgentMcpServer";
import { Concept62RetrievalRag } from "./concepts/Concept62RetrievalRag";

import { Concept63SafeDatabaseAgent } from "./concepts/Concept63SafeDatabaseAgent";
import { Concept64BrowserPlaywrightMcp } from "./concepts/Concept64BrowserPlaywrightMcp";
import { Concept65HumanApproval } from "./concepts/Concept65HumanApproval";
import { Concept66RealtimeWebSocket } from "./concepts/Concept66RealtimeWebSocket";
import { Concept67MultiTenantSaas } from "./concepts/Concept67MultiTenantSaas";
import { Concept68ScheduledAgents } from "./concepts/Concept68ScheduledAgents";
import { Concept69EmbeddingSdk } from "./concepts/Concept69EmbeddingSdk";
import { Concept70PythonSdk } from "./concepts/Concept70PythonSdk";
import { Concept71DataAnalysisAgent } from "./concepts/Concept71DataAnalysisAgent";
import { Concept72DocumentGenerationSkills } from "./concepts/Concept72DocumentGenerationSkills";
import { Concept73PrReviewerFixer } from "./concepts/Concept73PrReviewerFixer";
import { Concept74PromptInjectionRedTeam } from "./concepts/Concept74PromptInjectionRedTeam";
// Each new concept adds one entry here.
const concepts = [
  { id: 1, title: "query()", Component: Concept01Query },
  { id: 2, title: "Options", Component: Concept02Options },
  { id: 3, title: "Built-in tools", Component: Concept03Tools },
  { id: 4, title: "Permissions", Component: Concept04Permissions },
  { id: 5, title: "Custom tools", Component: Concept05CustomTools },
  { id: 6, title: "Sessions", Component: Concept06Sessions },
  { id: 7, title: "Hooks", Component: Concept07Hooks },
  { id: 8, title: "Subagents", Component: Concept08Subagents },
  { id: 9, title: "System prompts", Component: Concept09SystemPrompts },
  { id: 10, title: "Structured output & interrupt", Component: Concept10StructuredInterrupt },
  { id: 11, title: "Skills", Component: Concept11Skills },
  { id: 12, title: "Streaming input", Component: Concept12StreamingInput },
  { id: 13, title: "MCP servers", Component: Concept13McpServers },
  { id: 14, title: "Thinking, effort & models", Component: Concept14ThinkingEffortModels },
  { id: 15, title: "Cost & usage", Component: Concept15CostUsage },
  { id: 16, title: "Settings & env", Component: Concept16SettingsEnv },
  { id: 17, title: "Checkpointing & rewind", Component: Concept17Checkpointing },
  { id: 18, title: "Sandbox", Component: Concept18Sandbox },
  { id: 19, title: "Session management", Component: Concept19SessionManagement },
  { id: 20, title: "Hooks in depth", Component: Concept20HooksInDepth },
  { id: 21, title: "Slash commands", Component: Concept21SlashCommands },
  { id: 22, title: "CLAUDE.md & memory", Component: Concept22ClaudeMdMemory },
  { id: 23, title: "Plugins", Component: Concept23Plugins },
  { id: 24, title: "Harnesses", Component: Concept24Harnesses },
  { id: 25, title: "Compaction & context", Component: Concept25CompactionContext },
  { id: 26, title: "Query control methods", Component: Concept26QueryControl },
  { id: 27, title: "Background tasks", Component: Concept27BackgroundTasks },
  { id: 28, title: "Errors, retries & recovery", Component: Concept28ErrorsRetries },
  { id: 29, title: "Images & file input", Component: Concept29ImagesFiles },
  { id: 30, title: "Todo tracking", Component: Concept30TodoTracking },
  { id: 31, title: "AskUserQuestion", Component: Concept31AskUserQuestion },
  { id: 32, title: "Plan mode", Component: Concept32PlanMode },
  { id: 33, title: "MCP elicitation", Component: Concept33McpElicitation },
  { id: 34, title: "Output styles", Component: Concept34OutputStyles },
  { id: 35, title: "Session stores", Component: Concept35SessionStores },
  { id: 36, title: "Process spawning", Component: Concept36ProcessSpawning },
  { id: 37, title: "Permission prompt tool", Component: Concept37PermissionPromptTool },
  { id: 38, title: "Prompt suggestions", Component: Concept38PromptSuggestions },
  { id: 39, title: "projectConfigRoot", Component: Concept39ProjectConfigRoot },
  { id: 40, title: "resumeDropsTurn", Component: Concept40ResumeDropsTurn },
  { id: 41, title: "V2 session API", Component: Concept41V2SessionApi },
  { id: 42, title: "Web tools", Component: Concept42WebTools },
  { id: 43, title: "Remote MCP + resources", Component: Concept43RemoteMcp },
  { id: 44, title: "OpenTelemetry", Component: Concept44OtelObservability },
  { id: 45, title: "Cloud providers", Component: Concept45CloudProviders },
  { id: 46, title: "Prompt caching & cost", Component: Concept46PromptCaching },
  { id: 47, title: "Multi-agent orchestration", Component: Concept47MultiAgent },
  { id: 48, title: "Security hardening", Component: Concept48SecurityHardening },
  { id: 49, title: "Deploy & CI headless", Component: Concept49DeployCiHeadless },
  { id: 50, title: "Full-stack capstone", Component: Concept50Capstone },
  { id: 51, title: "Unit-testing agents without the API", Component: Concept51UnitTesting },
  { id: 52, title: "Evals: judges & regression baselines", Component: Concept52Evals },
  { id: 53, title: "Debugging an agent run", Component: Concept53Debugging },
  { id: 54, title: "Designing tools the model uses well", Component: Concept54ToolDesign },
  { id: 55, title: "Upgrading the SDK safely", Component: Concept55UpgradingSdk },
  { id: 56, title: "Agent teams and inter-agent messaging", Component: Concept56AgentTeams },
  { id: 57, title: "Parallel workers in git worktrees", Component: Concept57ParallelWorktrees },
  { id: 58, title: "Tool search and large tool catalogs", Component: Concept58ToolSearch },
  { id: 59, title: "Model routing", Component: Concept59ModelRouting },
  { id: 60, title: "Durable, long-running agents", Component: Concept60DurableAgents },
  { id: 61, title: "Exposing your agent as an MCP server", Component: Concept61AgentMcpServer },
  { id: 62, title: "Retrieval (RAG) through custom tools", Component: Concept62RetrievalRag },
  { id: 63, title: "A safe database agent", Component: Concept63SafeDatabaseAgent },
  { id: 64, title: "Browser automation with Playwright MCP", Component: Concept64BrowserPlaywrightMcp },
  { id: 65, title: "Human approval over Slack, Teams or email", Component: Concept65HumanApproval },
  { id: 66, title: "Real-time frontends over WebSocket", Component: Concept66RealtimeWebSocket },
  { id: 67, title: "A multi-tenant SaaS architecture", Component: Concept67MultiTenantSaas },
  { id: 68, title: "Scheduled and event-driven agents", Component: Concept68ScheduledAgents },
  { id: 69, title: "Embedding the SDK in a desktop app or IDE extension", Component: Concept69EmbeddingSdk },
  { id: 70, title: "The Python SDK", Component: Concept70PythonSdk },
  { id: 71, title: "A data-analysis agent", Component: Concept71DataAnalysisAgent },
  { id: 72, title: "Document generation with Skills", Component: Concept72DocumentGenerationSkills },
  { id: 73, title: "An autonomous PR reviewer and fixer", Component: Concept73PrReviewerFixer },
  { id: 74, title: "Prompt-injection red-teaming", Component: Concept74PromptInjectionRedTeam },
];

// Keep lesson numbers stable while grouping the navigation by topic.
const sections = [
  { id: "fundamentals", title: "SDK fundamentals", lessons: [1, 2, 3, 5, 9, 10, 12, 14, 29, 34, 70] },
  { id: "sessions", title: "Sessions & context", lessons: [6, 17, 19, 25, 26, 27, 35, 40, 41] },
  { id: "configuration", title: "Configuration & hooks", lessons: [7, 16, 20, 22, 36, 39] },
  { id: "extensions", title: "Tools & extensions", lessons: [11, 13, 21, 23, 33, 42, 43, 54, 58, 61, 62, 64] },
  { id: "workflows", title: "Agent workflows", lessons: [24, 28, 30, 31, 32, 38, 65, 71, 72, 73] },
  { id: "agents", title: "Multi-agent systems", lessons: [8, 47, 56, 57] },
  { id: "security", title: "Permissions & security", lessons: [4, 18, 37, 48, 63, 74] },
  { id: "production", title: "Production & deployment", lessons: [15, 44, 45, 46, 49, 50, 51, 52, 53, 55, 59, 60, 66, 67, 68, 69] },
];

export function App() {
  const [active, setActive] = useState<number | null>(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("lesson"));
    return concepts.some((lesson) => lesson.id === requested) ? requested : null;
  });
  const [openSections, setOpenSections] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationView, setNavigationView] = useState<"lessons" | "topics">("lessons");
  const contentRef = useRef<HTMLElement>(null);
  const current = concepts.find((c) => c.id === active);
  const currentSection = active === null ? undefined : sections.find((s) => s.lessons.includes(active));
  const Current = current?.Component;

  function selectLesson(id: number) {
    setActive(id);
    const url = new URL(window.location.href);
    url.searchParams.set("lesson", String(id));
    window.history.replaceState(null, "", url);
    const section = sections.find((item) => item.lessons.includes(id));
    if (section) setOpenSections((open) => open.includes(section.id) ? open : [...open, section.id]);
    setMenuOpen(false);
    contentRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  function goHome() {
    setActive(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("lesson");
    window.history.replaceState(null, "", url);
    setOpenSections([]);
    setMenuOpen(false);
    contentRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="app-layout">
      <a className="skip-link" href="#lesson-content">Skip to lesson</a>
      <aside className="lesson-sidebar" aria-label="Course navigation">
        <header className="sidebar-header">
          <a
            className="sidebar-home-link"
            href={import.meta.env.BASE_URL}
            aria-label="Claude Agent SDK Lab home"
            aria-current={active === null ? "page" : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              goHome();
            }}
          >
            <h1>Claude Agent SDK Lab</h1>
            <p>{concepts.length} lessons · {sections.length} sections</p>
          </a>
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="lesson-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? "Hide lessons" : "Browse lessons"}
          </button>
        </header>
        <nav id="lesson-navigation" className={`lesson-navigation${menuOpen ? " is-open" : ""}`} aria-label="Lessons">
          <div className="navigation-views" aria-label="Menu order">
            <button type="button" aria-pressed={navigationView === "lessons"} onClick={() => setNavigationView("lessons")}>Lesson order</button>
            <button type="button" aria-pressed={navigationView === "topics"} onClick={() => setNavigationView("topics")}>By topic</button>
          </div>
          {navigationView === "lessons" ? <ol className="lesson-list lesson-list-ordered">
            {[...concepts].sort((a, b) => a.id - b.id).map((lesson) => <li key={lesson.id}>
              <button
                type="button"
                className={`lesson-link${lesson.id === active ? " active" : ""}`}
                aria-current={lesson.id === active ? "page" : undefined}
                onClick={() => selectLesson(lesson.id)}
              >
                <span className="lesson-number">{lesson.id}.</span>
                <span>{lesson.title}</span>
              </button>
            </li>)}
          </ol> : sections.map((section) => {
            const expanded = openSections.includes(section.id);
            return (
              <div className="navigation-section" key={section.id}>
                <button
                  type="button"
                  className={`section-toggle${section.id === currentSection?.id ? " contains-active" : ""}`}
                  aria-expanded={expanded}
                  aria-controls={`lessons-${section.id}`}
                  onClick={() => setOpenSections((open) => expanded
                    ? open.filter((id) => id !== section.id)
                    : [...open, section.id])}
                >
                  <span className="section-chevron" aria-hidden="true">›</span>
                  <span className="section-title">{section.title}</span>
                  <span className="section-count">{section.lessons.length}</span>
                </button>
                <ul id={`lessons-${section.id}`} className="lesson-list" hidden={!expanded}>
                  {section.lessons.map((id) => {
                    const lesson = concepts.find((c) => c.id === id)!;
                    return (
                      <li key={lesson.id}>
                        <button
                          type="button"
                          className={`lesson-link${lesson.id === active ? " active" : ""}`}
                          aria-current={lesson.id === active ? "page" : undefined}
                          onClick={() => selectLesson(lesson.id)}
                        >
                          <span className="lesson-number">{lesson.id}.</span>
                          <span>{lesson.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>
      <main id="lesson-content" className="lesson-content" ref={contentRef} tabIndex={-1}>
        <div className="course-banner-container">
        <img
          className={`course-banner${active !== null ? " course-banner-compact" : ""}`}
          src={`${import.meta.env.BASE_URL}ClaudeAgentsSDK_LandingPage.png`}
          alt="Claude Agent SDK — Build Production AI Agents. Author: Luis Coco Enríquez."
          width={1332}
          height={750}
        />
        </div>
        {Current && currentSection ? <>
          <p className="lesson-breadcrumb">{currentSection.title} <span aria-hidden="true">/</span> Lesson {active}</p>
          <Current />
        </> : <section>
          <h2>Claude Agent SDK Lab</h2>
          <p className="lead">Choose a lesson from the menu to get started.</p>
        </section>}
      </main>
    </div>
  );
}



