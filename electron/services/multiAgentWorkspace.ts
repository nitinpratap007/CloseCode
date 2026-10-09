// Close Code — Multi-Agent Parallel Workspace (Phase 46)
// 
// Enables controlled parallel development with multiple agents working
// concurrently on isolated tasks within the same project.
//
// Supported agents:
// — Frontend agent: UI components, React/Vue/Angular work
// — Backend agent: API, services, database work
// — Testing agent: test generation, validation, quality checks
// — Security agent: security scanning, remediation
// — Reviewer agent: code quality, style, best practices
//
// Workspace isolation using:
// — Git branches (feature branches per agent)
// — Git worktrees (isolated working directories)
// — Isolated task contexts (per-agent state management)
//
// Philosophy:
// — Controlled parallelism: agents run concurrently but within resource limits
— Conflict prevention: branch-per-agent strategy; auto-merge safeguards
— Result isolation: each agent's changes tracked separately
— User oversight: user can inspect, approve, or revert each agent's work
— No silent overwrites: every file change tracked and reviewable
— Resource limits: max concurrent agents, timeout per agent, queue system

import { app, ipcMain, execSync } from "electron";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

// ---- Agent types and states ----

export type AgentId = string;
export type AgentType = 
  | "frontend"
  | "backend" 
  | "testing"
  | "security"
  | "reviewer";

export interface AgentContext {
  id: AgentId;
  type: AgentType;
  name: string;
  status: "idle" | "working" | "paused" | "completed" | "failed";
  currentTask: string | null;
  startedAt: number;
  completedAt: number | null;
  workspaceBranch: string;
  workspaceRoot: string;
  filesModified: string[]; // relative paths
  filesCreated: string[];
  filesDeleted: string[];
  summary: string;
}

export interface AgentTask {
  id: string;
  agentId: AgentId;
  description: string;
  priority: number; // 1 (low) to 5 (high)
  status: "pending" | "in-progress" | "completed" | "failed" | "cancelled";
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  context: Record<string, unknown>;
  result?: {
    success: boolean;
    output: string;
    artifacts: string[]; // file paths created/modified
    error?: string;
  };
}

// ---- Branch/worktree management ----

/**
 * Create a new branch for an agent's work.
 */
function createAgentBranch(agentId: AgentId, agentType: AgentType, projectRoot: string): { ok: boolean; branch: string; error?: string } {
  const branchName = `agent/${agentType}/${agentId}-${Date.now()}`;
  
  try {
    // Check if branch already exists
    const existsCheck = execSync(`git rev-parse --verify ${branchName}^{{commit}} 2>/dev/null`, {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return { ok: false, error: `Branch ${branchName} already exists` };
  } catch {
    // Branch doesn't exist — create it from current HEAD
    try {
      execSync(`git checkout -b ${branchName}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
      return { ok: true, branch: branchName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to create branch" };
    }
  }
}

/**
 * Create a worktree for an agent's branch.
 */
function createAgentWorktree(agentId: AgentId, branch: string, projectRoot: string): { ok: boolean; worktreePath: string; error?: string } {
  const worktreePath = path.join(projectRoot, `.worktrees`, `agent-${agentId}`);
  
  try {
    // Ensure worktrees directory exists
    const worktreesDir = path.join(projectRoot, ".worktrees");
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }
    
    // Check if worktree already exists
    if (fs.existsSync(worktreePath)) {
      return { ok: false, error: `Worktree ${worktreePath} already exists` };
    }
    
    // Create the worktree (detached)
    execSync(`git worktree add --detach ${worktreePath} ${branch}`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
    
    // Create agent-specific subdirectory
    const agentDir = path.join(worktreePath, `agent-${agentId}`);
    fs.mkdirSync(agentDir, { recursive: true });
    
    return { ok: true, worktreePath, error: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to create worktree" };
  }
}

/**
 * Remove an agent's worktree and branch.
 */
function removeAgentWorkspace(agentId: AgentId, projectRoot: string): { ok: boolean; error?: string } {
  const branchName = `agent/${getAgentTypeFromId(agentId)}/${agentId}-${Date.now()}`;
  const worktreePath = path.join(projectRoot, `.worktrees`, `agent-${agentId}`);
  
  try {
    // Remove worktree first
    if (fs.existsSync(worktreePath)) {
      execSync(`git worktree remove ${worktreePath}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    
    // Note: we don't delete the branch automatically — user can decide
    // return { ok: true, error: undefined };
    
    // Actually, let's keep the branch for now — it's useful for review
    return { ok: true, error: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to remove worktree" };
  }
}

// ---- Agent state management ----

const agentContexts: Map<AgentId, AgentContext> = new Map();
const agentTasks: Map<AgentId, AgentTask[]> = new Map();
const maxConcurrentAgents = 3; // Resource limit

function getAgentTypeFromId(agentId: AgentId): AgentType {
  // Extract from the agent contexts map
  for (const [id, ctx] of agentContexts.entries()) {
    if (id === agentId) return ctx.type;
  }
  return "frontend" as AgentType; // default
}

// ---- IPC handlers ---

export function registerMultiAgentIpc(): void {
  // --- Agent management ---

  ipcMain.handle("multiAgent:create-agent", async (_e, { type, name }: { type: AgentType; name: string }) => {
    try {
      // Enforce resource limit
      const agentCount = Array.from(agentContexts.values()).filter(
        (ctx) => ctx.status === "working"
      ).length;
      
      if (agentCount >= maxConcurrentAgents) {
        return { ok: false, error: `Maximum concurrent agents (${maxConcurrentAgents}) reached` };
      }
      
      const agentId = uuidv4();
      const projectRoot = app.getPath("userData"); // In production: project workspace root
      
      // Create branch and worktree for isolation
      const branchResult = createAgentBranch(agentId, type, projectRoot);
      if (!branchResult.ok) return { ok: false, error: branchResult.error };
      
      const worktreeResult = createAgentWorktree(agentId, branchResult.branch, projectRoot);
      if (!worktreeResult.ok) {
        // Clean up branch on worktree failure
        try {
          execSync(`git branch -D ${branchResult.branch}`, { cwd: projectRoot, stdio: "pipe" });
        } catch {}
        return { ok: false, error: worktreeResult.error };
      }
      
      // Initialize agent context
      const context: AgentContext = {
        id: agentId,
        type,
        name,
        status: "idle",
        currentTask: null,
        startedAt: Date.now(),
        completedAt: null,
        workspaceBranch: branchResult.branch,
        workspaceRoot: projectRoot,
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        summary: `Agent ${name} (${type}) initialized on branch ${branchResult.branch}`,
      };
      
      agentContexts.set(agentId, context);
      agentTasks.set(agentId, []);
      
      return { ok: true, result: { agentId, context, branch: branchResult.branch, worktree: worktreeResult.worktreePath } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("multiAgent:remove-agent", async (_e, agentId: string) => {
    try {
      // Stop working agent if needed
      const context = agentContexts.get(agentId);
      if (context && context.status === "working") {
        // Cancel the agent's work
        // In production, this would involve more graceful cancellation
        context.status = "failed";
        context.completedAt = Date.now();
        agentContexts.set(agentId, context);
      }
      
      // Remove workspace
      const removeResult = removeAgentWorkspace(agentId, app.getPath("userData"));
      if (!removeResult.ok) {
        return { ok: false, error: removeResult.error };
      }
      
      // Remove context and tasks
      agentContexts.delete(agentId);
      agentTasks.delete(agentId);
      
      return { ok: true, result: { removed: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("multiAgent:get-status", async (_e, agentId?: string) => {
    try {
      if (agentId) {
        const context = agentContexts.get(agentId);
        if (!context) return { ok: false, error: "Agent not found" };
        return { ok: true, result: context };
      }
      
      // Return all agents
      const allAgents = Array.from(agentContexts.values()).map((ctx) => ({
        id: ctx.id,
        type: ctx.type,
        name: ctx.name,
        status: ctx.status,
        currentTask: ctx.currentTask,
        filesModified: ctx.filesModified,
        summary: ctx.summary,
      }));
      
      return { ok: true, result: allAgents };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Task management ---

  ipcMain.handle("multiAgent:create-task", async (_e, { agentId, description, priority }: { agentId: string; description: string; priority?: number }) => {
    try {
      const context = agentContexts.get(agentId);
      if (!context) return { ok: false, error: "Agent not found" };
      
      if (context.status !== "idle" && context.status !== "paused") {
        return { ok: false, error: `Agent is currently ${context.status}` };
      }
      
      const taskId = uuidv4();
      const task: AgentTask = {
        id: taskId,
        agentId,
        description,
        priority: priority ?? 3,
        status: "pending",
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        context: {},
      };
      
      // Add task to agent's queue
      const tasks = agentTasks.get(agentId) || [];
      tasks.push(task);
      agentTasks.set(agentId, tasks);
      
      // If agent is idle, start the first task
      if (context.status === "idle") {
        context.status = "working";
        context.currentTask = taskId;
        context.startedAt = Date.now();
        agentContexts.set(agentId, context);
        
        // Start task processing
        processAgentTask(agentId, taskId);
      }
      
      return { ok: true, result: { taskId, task } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle("multiAgent:cancel-task", async (_e, { agentId, taskId }: { agentId: string; taskId: string }) => {
    try {
      const tasks = agentTasks.get(agentId);
      if (!tasks) return { ok: false, error: "Agent has no tasks" };
      
      const taskIndex = tasks.findIndex((t) => t.id === taskId);
      if (taskIndex === -1) return { ok: false, error: "Task not found" };
      
      tasks[taskIndex].status = "cancelled";
      tasks[taskIndex].completedAt = Date.now();
      
      // If this was the current task and agent has more tasks, start the next
      const context = agentContexts.get(agentId);
      if (context && context.currentTask === taskId) {
        context.currentTask = null;
        // Start next task if available
        const nextTask = tasks.find((t) => t.status === "pending");
        if (nextTask) {
          processAgentTask(agentId, nextTask.id);
        } else {
          context.status = "idle";
          context.currentTask = null;
          context.completedAt = Date.now();
        }
        agentContexts.set(agentId, context);
      }
      
      return { ok: true, result: { cancelled: true } };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Status inspection ---

  ipcMain.handle("multiAgent:inspect-changes", async (_e, agentId: string) => {
    try {
      const context = agentContexts.get(agentId);
      if (!context) return { ok: false, error: "Agent not found" };
      
      // Get the diff of changes in the worktree
      const projectRoot = context.workspaceRoot;
      const worktreePath = path.join(projectRoot, `.worktrees`, `agent-${agentId}`);
      
      let diffOutput = "No worktree available";
      if (fs.existsSync(worktreePath)) {
        try {
          diffOutput = execSync(`git diff HEAD`, {
            cwd: worktreePath,
            stdio: "pipe",
          }).toString();
        } catch {
          diffOutput = "Could not generate diff";
        }
      }
      
      return {
        ok: true,
        result: {
          context,
          diff: diffOutput,
          workspaceBranch: context.workspaceBranch,
          worktreePath,
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // --- Result collection ---

  ipcMain.handle("multiAgent:get-results", async (_e, agentId: string) => {
    try {
      const context = agentContexts.get(agentId);
      if (!context) return { ok: false, error: "Agent not found" };
      
      const tasks = agentTasks.get(agentId) || [];
      const completedTasks = tasks.filter((t) => t.status === "completed" || t.status === "failed");
      
      return {
        ok: true,
        result: {
          context,
          completedTasks,
          summary: {
            total: tasks.length,
            completed: completedTasks.length,
            failed: completedTasks.filter((t) => t.status === "failed").length,
          },
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * Process an agent's task - this is the internal workflow
 */
function processAgentTask(agentId: string, taskId: string) {
  const context = agentContexts.get(agentId);
  const tasks = agentTasks.get(agentId);
  
  if (!context || !tasks) return;
  
  // Find the task
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.status !== "pending") return;
  
  // Mark as in-progress
  task.status = "in-progress";
  task.startedAt = Date.now();
  context.currentTask = taskId;
  context.status = "working";
  agentTasks.set(agentId, tasks);
  agentContexts.set(agentId, context);
  
  // In a real implementation, this would dispatch to agent-specific handlers
  // For now, simulate task completion after a brief delay
  setTimeout(() => {
    // Simulate task completion
    task.status = "completed";
    task.completedAt = Date.now();
    task.result = {
      success: true,
      output: `Task "${task.description}" completed by agent ${agentId}`,
      artifacts: [], // Would contain file paths in real implementation
    };
    
    // Update task and context
    tasks = agentTasks.get(agentId) || [];
    const taskIndex = tasks.findIndex((t) => t.id === taskId);
    if (taskIndex !== -1) tasks[tasks.length - 1] = task;
    agentTasks.set(agentId, tasks);
    
    context.currentTask = null;
    
    // Start next task if available
    const remainingTasks = tasks.filter((t) => t.status === "pending");
    if (remainingTasks.length > 0) {
      processAgentTask(agentId, remainingTasks[0].id);
    } else {
      context.status = "idle";
      context.currentTask = null;
      context.completedAt = Date.now();
    }
    agentContexts.set(agentId, context);
  }, 1000); // 1 second simulation
}

// Export all for types
export type { AgentId, AgentType, AgentContext, AgentTask, AgentTask[] };
export { maxConcurrentAgents, processAgentTask, createAgentBranch, createAgentWorktree, removeAgentWorkspace };