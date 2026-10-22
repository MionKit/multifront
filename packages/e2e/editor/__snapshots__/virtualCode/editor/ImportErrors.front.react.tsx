
  import Card from '../Card.front'
  import VueOnly from '../imports/VueOnly.front'
  import Badge from '../Badge.front' with { framework: 'vue' }
  import Gone from '../Gone.front'
  export { default as Again } from '../imports/VueOnly.front'

  const lazyBadge = import('../Badge.front', { with: { framework: 'vue' } })

  export default function ImportErrors() {
    return <><Card /><VueOnly /><Badge label="New" /><Gone /></>
  }
