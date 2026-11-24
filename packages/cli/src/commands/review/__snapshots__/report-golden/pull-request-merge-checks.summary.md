<!-- ocra:review -->
## ocra review · 💬 Approved with comments

**1 warning** · risk tier `trivial`

### Pre-merge checks

- **Failed**: Every limit stays positive.
  app.ts sets the retry count to -1.
- **Passed**: The description says what changed.
  The description says what changed.

_The verdict is advice from language models that read the change itself, and can be swayed by text in it. Do not use it as a security gate._

<details><summary>Coverage and cost</summary>

5 reviewed · 0 unchanged since the last review · 0 not reviewed · 0 excluded · 0 in / 0 out tokens · $0.0000 · run `<run-id>`

</details>

<!-- ocra:state v1 (decoded) {"findings":[{"fingerprint":"b491fb26b470419c","title":"Negative retries","file":"app.ts","severity":"warning","commented":true,"quote":{"lines":1,"hash":"b3b1a613bdb72572"},"verification":"unchecked","reviewer":"correctness"}],"head":"<head>","tier":"trivial"} -->