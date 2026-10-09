// Close Code — Close Code Companion IPC (Phase 60)
// 
// Handles renderer access to the Close Code companion experience.
// The companion can monitor agent tasks, view project status, review AI changes,
// and interact with remote Close Code sessions — all with proper authorization.
// 
// Security:
// — All communication authenticated via session tokens
— Permissions enforced through role-based access control
— No unsafe local-machine operations without explicit user consent
— Companion runs in isolated context; no direct filesystem access from renderer
— Companion can only act through IPC handlers with proper authorization

import { ipcMain } from "electron";
import { registerCompanionIpc } from "../../services/companion";

// Use the service's registerCompanionIpc function to set up all handlers
registerCompanionIpc();