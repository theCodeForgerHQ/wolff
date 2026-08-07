import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface BuilderUiState {
  selectedBlockId: string | null;
  hoveredBlockId: string | null;
  showBlocksPanel: boolean;
  showPropertiesPanel: boolean;
  showRateCardPanel: boolean;
  previewMode: boolean;
  zoom: number;
}

export const initialBuilderUiState: BuilderUiState = {
  selectedBlockId: null,
  hoveredBlockId: null,
  showBlocksPanel: true,
  showPropertiesPanel: true,
  showRateCardPanel: false,
  previewMode: false,
  zoom: 100,
};

export const builderUiSlice = createSlice({
  name: 'builderUi',
  initialState: initialBuilderUiState,
  reducers: {
    selectBlock: (state, action: PayloadAction<string | null>) => {
      state.selectedBlockId = action.payload;
    },

    setHoveredBlock: (state, action: PayloadAction<string | null>) => {
      state.hoveredBlockId = action.payload;
    },

    toggleBlocksPanel: (state) => {
      state.showBlocksPanel = !state.showBlocksPanel;
    },

    togglePropertiesPanel: (state) => {
      state.showPropertiesPanel = !state.showPropertiesPanel;
    },

    toggleRateCardPanel: (state) => {
      state.showRateCardPanel = !state.showRateCardPanel;
    },

    togglePreviewMode: (state) => {
      state.previewMode = !state.previewMode;
      if (state.previewMode) {
        state.selectedBlockId = null;
      }
    },

    setZoom: (state, action: PayloadAction<number>) => {
      state.zoom = Math.min(Math.max(action.payload, 50), 200);
    },

    setShowBlocksPanel: (state, action: PayloadAction<boolean>) => {
      state.showBlocksPanel = action.payload;
    },

    setShowPropertiesPanel: (state, action: PayloadAction<boolean>) => {
      state.showPropertiesPanel = action.payload;
    },

    resetBuilderUi: () => initialBuilderUiState,
  },
});

export const builderUiActions = builderUiSlice.actions;
export default builderUiSlice.reducer;
