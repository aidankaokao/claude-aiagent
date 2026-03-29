"""
registry.py — 技能註冊器（SKILL.md 檔案式）

從 skills/<name>/SKILL.md 載入技能定義，不依賴資料庫。

SKILL.md 格式：
  ---
  display_name: Email 撰寫
  description: 說明文字
  icon: ✉️
  ---

  （system prompt 本文）

  ## Examples

  ### User
  （使用者輸入）

  ### Assistant
  （期望輸出）

每個技能一個目錄，目錄名稱即為技能 name（例如 skills/email/SKILL.md）。
"""

import re
from pathlib import Path

SKILLS_DIR = Path(__file__).parent


class SkillRegistry:

    def _parse_skill_md(self, skill_name: str) -> dict | None:
        """解析單一技能的 SKILL.md，回傳技能資訊 dict。"""
        skill_path = SKILLS_DIR / skill_name / "SKILL.md"
        if not skill_path.exists():
            return None

        content = skill_path.read_text(encoding="utf-8")

        # ── 解析 YAML frontmatter ──
        if not content.startswith("---\n"):
            return None
        end_fm = content.find("\n---\n", 4)
        if end_fm == -1:
            return None

        fm_str = content[4:end_fm]
        body = content[end_fm + 5:]  # 跳過 \n---\n

        meta: dict[str, str] = {}
        for line in fm_str.splitlines():
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip()] = val.strip()

        # ── 定位各區段（## Parameters、## Examples）──
        params_match   = re.search(r'^## Parameters\s*$', body, re.MULTILINE)
        examples_match = re.search(r'^## Examples\s*$',   body, re.MULTILINE)

        # system prompt = body 在第一個 ## 區段之前的部分
        section_starts = [m.start() for m in [params_match, examples_match] if m]
        system_prompt = body[:min(section_starts)].strip() if section_starts else body.strip()

        # ── 解析 ## Parameters ──
        parameters: list[dict] = []
        if params_match:
            params_body_start = params_match.end()
            # Parameters 區段到下一個 ## 或字串結尾
            next_section_starts = [
                m.start() for m in [examples_match]
                if m and m.start() > params_match.start()
            ]
            params_body_end = next_section_starts[0] if next_section_starts else len(body)
            params_section = body[params_body_start:params_body_end]

            for line in params_section.splitlines():
                line = line.strip()
                if not line or '|' not in line:
                    continue
                parts = [p.strip() for p in line.split('|')]
                if len(parts) < 4:
                    continue
                parameters.append({
                    "name":     parts[0],
                    "label":    parts[1],
                    "type":     parts[2],   # "text" | "textarea"
                    "required": parts[3].lower() == "required",
                })

        # ── 解析 ## Examples 下的 ### User / ### Assistant 配對 ──
        examples: list[dict] = []
        if examples_match:
            examples_section = body[examples_match.end():]
            blocks = re.split(r'^### (User|Assistant)\s*$', examples_section, flags=re.MULTILINE)
            # blocks = ['', 'User', 'text', 'Assistant', 'text', ...]
            i = 1
            while i < len(blocks) - 2:
                if blocks[i] == "User" and blocks[i + 2] == "Assistant":
                    examples.append({
                        "user_input":      blocks[i + 1].strip(),
                        "expected_output": blocks[i + 3].strip(),
                    })
                    i += 4
                else:
                    i += 2

        return {
            "name":         skill_name,
            "display_name": meta.get("display_name", skill_name),
            "description":  meta.get("description", ""),
            "icon":         meta.get("icon", "✨"),
            "system_prompt": system_prompt,
            "parameters":   parameters,
            "examples":     examples,
        }

    def get_all_skills(self) -> list[dict]:
        """掃描 skills/ 目錄，回傳所有含 SKILL.md 的技能清單。"""
        result = []
        for path in sorted(SKILLS_DIR.iterdir()):
            if path.is_dir() and (path / "SKILL.md").exists():
                skill = self._parse_skill_md(path.name)
                if skill:
                    result.append(skill)
        return result

    def get_skill_names(self) -> list[str]:
        """回傳所有技能名稱列表。"""
        return [s["name"] for s in self.get_all_skills()]

    def get_skill(self, skill_name: str) -> dict | None:
        """取得單一技能的完整資訊。"""
        return self._parse_skill_md(skill_name)

    def compose_system_prompt(self, skill_name: str) -> str:
        """
        組合最終 system prompt。

        步驟：
        1. 載入 SKILL.md 中的 system prompt
        2. 將 ## Examples 下的配對以 XML 格式注入 prompt 尾端

        XML 注入格式（業界慣例）：
          <examples>
            <example>
              <user>...</user>
              <assistant>...</assistant>
            </example>
          </examples>
        """
        skill = self._parse_skill_md(skill_name)
        if not skill:
            return "你是一個通用助手，請根據使用者的需求提供幫助。"

        prompt = skill["system_prompt"]

        if skill["examples"]:
            block = "\n\n<examples>"
            for ex in skill["examples"]:
                block += (
                    f"\n<example>"
                    f"\n<user>{ex['user_input']}</user>"
                    f"\n<assistant>{ex['expected_output']}</assistant>"
                    f"\n</example>"
                )
            block += "\n</examples>"
            prompt += block

        return prompt
