
  // A props type with the component's name: the default specifier still exports the function.
  interface Card {
    title: string
  }

  function Card({ title }: Card) {
    return <div className={$style.card}><h2>{title}</h2></div>
  }

  export { Card as default }
declare const $style: {readonly card: string};
