import { generateDashboard } from "../src/dashboard/generate.js";
const r = await generateDashboard();
console.log(`Dashboard written to ${r.path}`);
console.log(`Real data: ${r.totalSaved.toLocaleString()} est. tokens saved over ${r.calls} calls`);
