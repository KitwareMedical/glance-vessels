import Datasets from 'paraview-glance/src/components/core/Datasets';
import EditTools from 'paraview-glance/src/components/core/EditTools';
import GlobalSettings from 'paraview-glance/src/components/core/GlobalSettings';
import PreProcess from 'paraview-glance/src/components/vessels/PreProcess';

// ----------------------------------------------------------------------------

export default {
  name: 'ControlsDrawer',
  components: {
    Datasets,
    EditTools,
    GlobalSettings,
    PreProcess,
  },
  data() {
    return {
      activeTab: 0,

      WorkflowTabs: [
        {
          name: 'Pre-Process',
          component: PreProcess,
        },
      ],
    };
  },
};
