import { mock } from "bun:test";
import * as electron from "./electronStub.js";

mock.module("electron", () => electron);
