import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace Ores.InfraGitOps;

@id("InfraGitOpsContract")
model InfraGitOpsContract {
  supabaseRoot: string;
  neonRoot: string;
  cloudflareRoot: string;
  awsRoot: string;
  gcpRoot: string;
  tfRoot: string;
  secretPolicy: string;
  promotionPolicy: string;
}
