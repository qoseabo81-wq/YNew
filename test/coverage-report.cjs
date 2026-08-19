const { Report } = require("c8");

const report = new Report({
  reporter: ["text", "json-summary"],
  reportsDirectory: "coverage",
  tempDirectory: "coverage/tmp",
  all: true,
  extension: [".ts", ".tsx"],
  exclude: [
    "test/**",
    "src/index.ts",
    "src/types/**",
    "**/*.d.ts"
  ]
});

report.run()
  .then(() => {
    console.log("COVERAGE REPORT FINISHED");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
