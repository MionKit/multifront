
  import Card from '../Card.ucf'
  import VueOnly from '../imports/VueOnly.ucf'
  import Badge from '../Badge.ucf' with { framework: 'vue' }

  export default function ImportErrors() {
    return <><Card /><VueOnly /><Badge label="New" /></>
  }
