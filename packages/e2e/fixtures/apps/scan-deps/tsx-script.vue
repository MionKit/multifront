<!-- A `.vue` importer defaults to vue; its JSX parses only as tsx, which the scan names in the module type alone. -->
<script lang="tsx">
import Mount from './Mount.ucf' with {framework: 'react'};

export default {render: () => <div>{String(Mount)}</div>};
</script>
