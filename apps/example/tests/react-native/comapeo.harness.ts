import { test, expect } from "react-native-harness";
import { comapeo } from "@comapeo/core-react-native";

test("comapeo export should be available", () => {
  expect(comapeo).toBeDefined();
});
