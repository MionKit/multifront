<template>
  <div class="box">
    <h1 class="title">Reference</h1>
    <p :class="$style.note">plugin-vue on its own</p>
    <span class="inner">scoped scss</span>
  </div>
</template>

<style scoped>
.title {
  color: rebeccapurple;
}
</style>

<style module>
.note {
  font-style: italic;
}
</style>

<style scoped lang="scss">
$gap: 8px;

.box {
  padding: $gap;

  .inner {
    margin-left: $gap * 2;
  }
}
</style>
