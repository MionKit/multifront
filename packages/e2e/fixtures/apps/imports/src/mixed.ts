// Types keep one resolution per specifier, the last one (react) for both; the build follows each attribute.
import VueCard from '../../../components/Card.ucf' with {framework: 'vue'};
import ReactCard from '../../../components/Card.ucf' with {framework: 'react'};

export {ReactCard, VueCard};
