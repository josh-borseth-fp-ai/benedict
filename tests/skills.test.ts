import assert from "node:assert/strict"
import { test } from "node:test"
import { parseSkill, skillsForPath } from "../src/skills.js"

const parse = (frontmatter: string, body = "Guidance.\n") => parseSkill(`---\n${frontmatter}\n---\n${body}`, "api-auth", "repository", "api-auth/SKILL.md")

test("skills read name, description and optional paths from frontmatter", () => {
  assert.deepEqual(parse("name: api-auth\ndescription: Authorization rules.\nlicense: MIT\nmetadata:\n  owner: platform"), {
    name: "api-auth", description: "Authorization rules.", scope: "repository", content: "Guidance.\n"
  })
  const listed = parse("name: \"api-auth\"\ndescription: >\n  Authorization rules\n  for the API.\npaths:\n  - \"api/**\"\n  - 'src/**/*.{ts,tsx}'\n- lib/*.ts")
  assert.equal(listed.description, "Authorization rules for the API.")
  assert.deepEqual(listed.paths, ["api/**", "src/**/*.{ts,tsx}", "lib/*.ts"])
  assert.deepEqual(parse("name: api-auth\ndescription: 'It''s plain' # comment\npaths: [\"api/**\", \"web/**\"]").paths, ["api/**", "web/**"])
  assert.equal(parse("name: api-auth\ndescription: It's plain # comment").description, "It's plain")
  assert.equal(parseSkill("---\r\nname: api-auth\r\ndescription: CRLF.\r\n---\r\nBody\r\n", "api-auth", "repository", "x").content, "Body\n")
})

test("invalid skills are rejected", () => {
  for (const frontmatter of [
    "description: Missing name.",
    "name: other\ndescription: Wrong directory.",
    "name: API-Auth\ndescription: Uppercase.",
    "name: api-auth",
    "name: api-auth\ndescription: \"unterminated",
    "name: api-auth\ndescription: Bad paths.\npaths: api/**",
    "name: api-auth\ndescription: Bad paths.\npaths: [api/**]",
    "name: api-auth\ndescription: Absolute.\npaths: [\"/api/**\"]",
    "name: api-auth\ndescription: Brackets.\npaths: [\"api/[\"]",
    "  indented: true"
  ]) assert.throws(() => parse(frontmatter), (error: { code?: string }) => error.code === "skill_error", frontmatter)
  assert.throws(() => parseSkill("name: api-auth\n", "api-auth", "repository", "x"), /frontmatter/)
  assert.throws(() => parse("name: api-auth\ndescription: Large.", "x".repeat(262144)), /256 KiB/)
})

test("skills without paths apply everywhere; paths are anchored globs", () => {
  const skills = [
    { name: "correctness", description: "d", scope: "built-in" as const },
    { name: "api-auth", description: "d", scope: "repository" as const, paths: ["api/**", "*.sql"] }
  ]
  assert.deepEqual(skillsForPath("api/v1/user.ts", skills), ["correctness", "api-auth"])
  assert.deepEqual(skillsForPath("web/api/user.ts", skills), ["correctness"])
  assert.deepEqual(skillsForPath("schema.sql", skills), ["correctness", "api-auth"])
  assert.deepEqual(skillsForPath("db/schema.sql", skills), ["correctness"])
})
