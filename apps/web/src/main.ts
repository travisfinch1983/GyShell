/**
 * GyShell Web Entry Point
 *
 * Loads the window.gyshell WebSocket shim, then bootstraps
 * the same desktop renderer UI used in the Electron app.
 */

// Install the gyshell API shim BEFORE any renderer code loads
import './gyshell-web-shim'

// Now load the desktop renderer
import '../../../packages/ui/src/renderer_v2/index'
