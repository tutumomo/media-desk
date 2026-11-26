---
name: media-desk
description: 自媒體工作台（Media Desk）標準技能。協助創作者管理靈感收集、對標風格提煉、一鍵成稿（口播腳本與圖文文章）、AI 生圖（封面/配圖/分鏡）、排期發佈、數據復盤與寫作規則沉澱。當使用者提到靈感、選題、腳本、文章、寫作風格、分鏡、自媒體排期、復盤或 Media Desk 時使用此技能。
---

# Media Desk（自媒體工作台）標準技能

本技能將原本依賴 DeepSeek Harness 的 `dsh-media-desk` 轉換為任何通用智能體皆可透過 CLI（`media-desk`）與標準提示詞工作流操作的工具。

若 `media-desk` 指令可用（已透過 `npm install -g .` 全域安裝），請直接使用 `media-desk`；若未全域安裝，可改用專案目錄下的 `node bin/media-desk.js`。

所有資料預設儲存在 `$MEDIA_DESK_HOME/media-desk`（若未設定則相容 `$DSH_HOME/media-desk` 或 `~/.dsh/media-desk`），與桌面/Web 工作台共用同一份本地資料。

---

## 核心工作流

### 1. 檢查工作台狀態與設定

在開始創作或操作前，先了解目前的靈感庫、啟用中的風格卡與寫作規則：

```bash
media-desk state --compact
media-desk config show
```

- 若工作台只有內建示例資料且使用者想清空，可執行：
  ```bash
  media-desk clear-samples
  ```
- 若需要啟動視覺化 Web 工作台給使用者預覽、修圖或合成影片封面：
  ```bash
  media-desk serve --port 4311
  ```

### 2. 收集靈感與抓取網頁

- **新增靈感**：
  ```bash
  media-desk item add --title "標題" --body "補充想法或素材" --kind note --tags "標籤1,標籤2"
  ```
- **抓取公開網頁並存為靈感**（自動過濾內網/本機位址）：
  ```bash
  media-desk harvest "https://example.com/article" --save
  ```
- **列出與查看靈感**：
  ```bash
  media-desk item list
  media-desk item get <id>
  ```

### 3. 提煉並套用寫作風格

當使用者提供喜歡的文章、腳本或公開連結，希望模仿其語氣與結構時：

1. **取得風格提煉提示詞**（支援 `--url`、`--file` 或 `--text`）：
   ```bash
   media-desk style prompt --name "風格名稱" --url "https://example.com/post"
   ```
2. **由你（智能體）閱讀提示詞中的原文並產出風格卡 JSON**，結構須包含：
   `name`, `summary`, `tone`, `structure`, `rhetoric`, `vocabulary`, `avoid`, `doExamples`, `dontExamples`, `promptGuidance`
3. **寫入風格卡並設為目前啟用風格**：
   ```bash
   media-desk style apply --json '<風格卡JSON>' --name "風格名稱"
   ```
   （若內容較長，建議寫入暫存檔後用 `--file path/to/style.json`）

切換既有風格或停用風格：
```bash
media-desk style list
media-desk style use <style-id|null>
```

### 4. 一鍵成稿（智能體直出 + 自動生圖）

當使用者要把某條靈感寫成「口播腳本」或「文章」時，採用「取得上下文 → 智能體生成 → 寫回工作台」兩段式流程：

1. **取得成稿所需完整上下文**（包含靈感內容、啟用中的風格卡與原文節錄、已確認的寫作規則、策劃案/正文提示詞）：
   ```bash
   media-desk produce prompt <item-id>
   ```
   （可加 `--format script` 或 `--format article` 指定體裁）

2. **由你（智能體）生成兩部分內容**：
   - **策劃案 JSON**（包含 `title`, `coverText`, `facts`, `outline`, `characters`, `cover`, `images`, `shots`）
   - **完整成稿 Markdown**（開頭第一行 `# 標題`，接著為完整口播腳本或文章正文）

3. **寫回工作台並觸發配圖**：
   ```bash
   media-desk produce apply <item-id> --plan-file plan.json --article-file article.md
   ```
   - 若使用者設定了生圖模型且開啟生圖，此指令會自動並發生成封面、配圖與分鏡圖。
   - 若只想寫入文字不生圖，加上 `--no-images`。

4. **局部修訂成稿**（當使用者要求「改開頭」、「把第 2 張圖換個畫面」等）：
   ```bash
   media-desk produce revise <item-id> --json '{"article":"...","coverPrompt":"..."}' --render
   ```
   加上 `--render` 時，只有提示詞被修改的圖片會重畫，未改動的圖片會保留。

5. **補畫圖片或匯出成稿資料夾**：
   ```bash
   media-desk produce render <item-id>
   media-desk produce export <item-id>
   ```

### 5. 排期、復盤與沉澱寫作規則

- **設定排期**（ISO 日期或 `null` 取消）：
  ```bash
  media-desk schedule <item-id> 2026-12-01T10:00:00Z --platform xiaohongshu
  ```
- **記錄發佈數據**：
  ```bash
  media-desk metric add --item <item-id> --platform xiaohongshu --views 12000 --likes 680 --saves 310
  ```
- **查看數據復盤與提煉規則提案**：
  ```bash
  media-desk insights --propose
  ```
- **管理寫作規則**：
  ```bash
  media-desk skill list
  media-desk skill add --name "規則名稱" --rule "具體寫作要求" --status active
  media-desk skill export
  ```

---

## 生圖設定說明

若使用者尚未設定生圖 API，可協助設定 OpenAI 相容介面、阿里百煉（`bailian`）或通義萬相（`wan`）：

```bash
media-desk config set --protocol openai --base-url "https://api.openai.com/v1" --api-key "sk-..." --model "gpt-image-1"
```

---

## 注意事項

- 所有寫入操作（`item add/update/delete`、`style apply`、`schedule`、`skill add` 等）皆支援 `media-desk undo` 撤銷上一步。
- 在執行 `produce apply` 前，務必先執行 `produce prompt <id>` 取得啟用中的風格與寫作規則，確保成稿符合使用者的風格與禁忌。
- 本技能不要求使用者安裝 `dsh`；只要有 Node.js（>=18）即可完整運作核心功能與 CLI。若要建置前端 Web UI（`npm run build`），需先安裝 `devDependencies`（`esbuild`）。
