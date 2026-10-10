
  export default function DuplicateStyleModule() {
    return <p className={`${$style.first} ${classes.second}`}>Duplicate style module</p>
  }
declare const $style: {readonly fifth: string};
declare const classes: {readonly second: string};
