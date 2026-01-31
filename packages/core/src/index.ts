import { PatternMachine, HttpRouter, printTree } from "./router";

const machine = new PatternMachine<string>();

// Complex set of routes to test visualization
machine.add("api/v1/users", "USERS");
machine.add("api/v1/users/{id}", "USER_DETAIL");
machine.add("api/v1/posts", "POSTS");
machine.add("assets/**/logo.png", "LOGO");
machine.add("health", "HEALTH");

console.log(printTree(machine));

// 1. Configure the Router
// We use a custom separator just to show it works, though default "" is usually fine.
const app = new HttpRouter<string>({
  methodSeparator: ":",
  delimiter: "/",
  ignoreTrailingDelimiter: true,
});

// 2. Define Routes
app.get("/api/users", "HANDLER_GET_USERS");
app.post("/api/users", "HANDLER_CREATE_USER");
app.get("/api/users/{id}", "HANDLER_GET_USER_DETAIL");
app.delete("/api/users/{id}", "HANDLER_DELETE_USER");

// 3. Visualize the "Method Branching"
console.log("--- Visualizing the Router Tree ---");
console.log(printTree(app.getMachine()));

// 4. Test Lookups
console.log("\n--- Testing Lookups ---");

const matchGet = app.lookup("GET", "/api/users/101");
console.log(
  "GET /api/users/101 ->",
  matchGet[0]?.data,
  "| Params:",
  matchGet[0]?.params,
);

const matchPost = app.lookup("POST", "/api/users");
console.log("POST /api/users    ->", matchPost[0]?.data);

const matchFail = app.lookup("DELETE", "/api/users"); // Should fail (only POST allowed on collection)
console.log("DELETE /api/users  ->", matchFail.length ? "Match" : "No Match");
