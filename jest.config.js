module.exports = {
  transform: {
    "^.+\\.[jt]sx?$": [
      "@swc/jest",
      { jsc: { parser: { syntax: "typescript", decorators: true } } },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["<rootDir>/.medusa/", "<rootDir>/node_modules/"],
  testMatch: ["**/src/**/__tests__/**/*.spec.[jt]s"],
}
