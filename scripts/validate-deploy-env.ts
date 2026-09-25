import { assertDeploymentEnv, deploymentEnvErrors } from "../lib/deployEnv";

const errors = deploymentEnvErrors();

if (errors.length === 0) {
  if (process.env.VERCEL_ENV) {
    console.log(`Deployment environment validated for Vercel ${process.env.VERCEL_ENV}.`);
  } else {
    console.log("Deployment environment validation skipped outside Vercel.");
  }
} else {
  assertDeploymentEnv();
}
