---
layout: page
---

<script setup>
import { onMounted } from 'vue'
import { useRouter, withBase } from 'vitepress'

onMounted(() => {
  const router = useRouter()
  router.go(withBase('/arch/tech-stack-overview'))
})
</script>

<!-- 新增架构文档时在 docs/.vitepress/config.ts 的 "/arch/" 侧栏登记；本页只做重定向，不维护文档列表。 -->
