import { PatternMachine, printTree } from "./router";

const machine = new PatternMachine<string>();

// Complex set of routes to test visualization
machine.add("api/v1/users", "USERS");
machine.add("api/v1/users/{id}", "USER_DETAIL");
machine.add("api/v1/posts", "POSTS");
machine.add("assets/**/logo.png", "LOGO");
machine.add("health", "HEALTH");

console.log(printTree(machine));
