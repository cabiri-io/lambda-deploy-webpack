const webpack = require("webpack");
const path = require("path");
const archiver = require("archiver");
const aws = require("aws-sdk");
const lambda = new aws.Lambda();
const fs = require("fs");

class LambdaDeployPlugin {
  constructor(options) {
    this.project = options.project || process.env.CBR_PROJECT_KEY;
    this.environment = options.environment || process.env.CBR_APP_ENV;
    this.workspace = options.workspace || process.env.CBR_APP_WORKSPACE;
    this.service = options.service;
    this.lambdaName = options.lambdaName;
    this.deploy = options.deploy;
  }

  apply(compiler) {
    if (!this.deploy) {
      return;
    }

    const logger = compiler.getInfrastructureLogger(LambdaDeployPlugin.name);
    compiler.hooks.thisCompilation.tap(
      LambdaDeployPlugin.name,
      (compilation) => {
        compilation.hooks.processAssets.tapPromise(
          {
            name: LambdaDeployPlugin.name,
            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER,
          },
          async () => {
            const outputPath = compilation.getPath(compiler.outputPath, {});
            for (const nameAndPath in compilation.assets) {
              if (!compilation.assets.hasOwnProperty(nameAndPath)) continue;

              const source = compilation.assets[nameAndPath].source();
              const fullPath = `${outputPath}/${nameAndPath}`;
              const zipFilePath = fullPath.replace(/\.js$/, ".zip");
              const output = fs.createWriteStream(zipFilePath);
              const archive = archiver("zip");

              let archiveCompleted;
              let archiveErrored;
              const archiveComplete = new Promise((resolve, reject) => {
                archiveCompleted = resolve;
                archiveErrored = reject;
              });

              // listen for all archive data to be written
              // 'close' event is fired only when a file descriptor is involved
              output.on("close", function () {
                logger.info(archive.pointer() + " total bytes");
                logger.info(
                  "archiver has been finalized and the output file descriptor has closed."
                );
                archiveCompleted();
              });

              // This event is fired when the data source is drained no matter what was the data source.
              // It is not part of this library but rather from the NodeJS Stream API.
              // @see: https://nodejs.org/api/stream.html#stream_event_end
              output.on("end", function () {
                logger.info("Data has been drained");
              });

              // good practice to catch warnings (ie stat failures and other non-blocking errors)
              archive.on("warning", function (err) {
                if (err.code === "ENOENT") {
                  // log warning
                } else {
                  // throw error
                  throw err;
                  archiveErrored(err);
                }
              });

              // good practice to catch this error explicitly
              archive.on("error", function (err) {
                archiveErrored(err);
              });

              archive.pipe(output);
              archive.append(source, { name: "index.js" });
              archive.finalize();

              const [_, functionName] = /(.*)\/index\.js/.exec(nameAndPath);

              let lambdaFunctionName = this.lambdaName;
              if (!this.lambdaName) {
                lambdaFunctionName = `${this.project}-${this.environment}-${this.workspace}-${this.service}-${functionName}`;
              }

              logger.info("Service name:", lambdaFunctionName);

              await archiveComplete;

              const zipFile = fs.readFileSync(zipFilePath);
              await lambda
                .updateFunctionCode({
                  FunctionName: lambdaFunctionName,
                  ZipFile: zipFile,
                })
                .promise();
              logger.info("Published");
            }
          }
        );
      }
    );
  }
}

module.exports = LambdaDeployPlugin;
