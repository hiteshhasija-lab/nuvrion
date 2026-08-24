# ADR-0001: Runnable TypeScript-compatible Node foundation

Status: provisional

The governing TADS proposes ASP.NET Core 8/C# but leaves backend confirmation open for Gate 1. The current workspace has Node.js 24 and does not have the .NET SDK or Docker. Milestone 1 therefore starts with dependency-free ECMAScript modules and explicit module/API/message boundaries so the full vertical thread can run and be tested now.

This does not silently close the runtime ADR. Before Milestone 2, the team must either confirm this runtime or port the hosts while preserving OpenAPI, SQL, message contracts, module ownership, and acceptance tests.
